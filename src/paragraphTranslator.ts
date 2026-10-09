import type * as vscode from "vscode";
import { getConfiguration } from "./configuration";
import { AsyncLruCache } from "./asyncLruCache";

const GOOGLE_TRANSLATE_HTML_URL = "https://translate-pa.googleapis.com/v1/translateHtml";
const GOOGLE_TRANSLATE_HTML_API_KEY = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";
const GOOGLE_TRANSLATE_HTML_CLIENT = "wt_lib";
const MICROSOFT_TRANSLATE_AUTH_URL = "https://edge.microsoft.com/translate/auth";
const MICROSOFT_TRANSLATE_URL = "https://api-edge.cognitive.microsofttranslator.com/translate";
const TRANSLATION_TIMEOUT_MS = 5000;
const TRANSLATION_PROBE_TEXT = "Library";

export type TranslationEngine = "google" | "microsoft";
export type TranslationResult = { text: string; engine: TranslationEngine };
export type TranslationSegmentsResult = { texts: string[]; engine: TranslationEngine };

export class ParagraphTranslator {
  declare output: import("vscode").OutputChannel;
  private readonly translationCache = new AsyncLruCache<TranslationResult | undefined>(256, 4_000_000, (value) => value?.text.length || 0);
  declare preferredEngine: TranslationEngine | undefined;
  declare engineProbePromise: Promise<TranslationEngine | undefined> | undefined;
  declare microsoftToken: string | undefined;
  declare microsoftTokenPromise: Promise<string | undefined> | undefined;
  private microsoftTokenExpiresAt = 0;
  /**
   * Creates a small translator for paragraph hover previews.
   *
   * @param output Output channel for translation failures.
   */
  constructor(output: vscode.OutputChannel) {
    this.output = output;
    this.preferredEngine = undefined;
    this.engineProbePromise = undefined;
    this.microsoftToken = undefined;
    this.microsoftTokenPromise = undefined;
  }

  /**
   * Detects the translation engine to use for paragraph hovers.
   *
   * Google is preferred because it was the original provider. Microsoft is used
   * only when the startup probe shows Google cannot be reached from this host.
   *
   */
  async initialize() {
    await this.ensurePreferredEngine();
  }

  /**
   * Translates one short English paragraph to the configured target language.
   *
   * @param text English paragraph text.
   */
  async translateText(text: string) {
    const targetLanguage = getConfiguration().get("paragraphHoverTranslationTargetLanguage", "zh");
    const engine = await this.ensurePreferredEngine();
    if (!engine) {
      return undefined;
    }

    if (!text) {
      return { text: "", engine };
    }

    const cacheKey = `${engine}:${targetLanguage}:${text}`;
    return this.translationCache.getOrCreate(cacheKey, () => this.translateTextWithEngine(text, targetLanguage, engine)
      .then((translatedText) => {
        if (translatedText === undefined) return undefined;
        return { text: translatedText, engine };
      })
      .catch((error): TranslationResult | undefined => {
        this.output.appendLine(`Paragraph translation failed unexpectedly: ${String(error)}`);
        return undefined;
      }));
  }

  /**
   * Translates sentence segments in one request while preserving their order.
   *
   * Both configured translation backends accept HTML, so paragraph tags keep
   * sentence boundaries stable without paying for one network request per
   * sentence. A per-sentence fallback handles providers that unexpectedly drop
   * those tags.
   *
   * @param texts Source sentence segments.
   */
  async translateTextSegments(texts: readonly string[]): Promise<TranslationSegmentsResult | undefined> {
    if (texts.length === 0) {
      const engine = await this.ensurePreferredEngine();
      return engine ? { texts: [], engine } : undefined;
    }

    if (texts.length === 1) {
      const translation = await this.translateText(texts[0]);
      return translation ? { texts: [translation.text], engine: translation.engine } : undefined;
    }

    const translatedHtml = await this.translateText(formatTranslationSegmentsHtml(texts));
    if (translatedHtml === undefined) {
      return undefined;
    }

    const translatedSegments = parseTranslationSegmentsHtml(translatedHtml.text);
    if (translatedSegments.length === texts.length) {
      return { texts: translatedSegments, engine: translatedHtml.engine };
    }

    // Some translation responses may flatten otherwise valid HTML boundaries.
    this.output.appendLine("Segmented paragraph translation lost its HTML boundaries; retrying sentences individually.");
    const individualTranslations = await Promise.all(texts.map((text) => this.translateText(text)));
    if (individualTranslations.some((translation) => translation === undefined)) {
      return undefined;
    }

    const completedTranslations = individualTranslations as TranslationResult[];
    return {
      texts: completedTranslations.map((translation) => translation.text),
      engine: completedTranslations[0].engine,
    };
  }

  /**
   * Returns the preferred translation engine, probing once if needed.
   *
   */
  async ensurePreferredEngine() {
    if (this.preferredEngine) {
      return this.preferredEngine;
    }

    if (!this.engineProbePromise) {
      this.engineProbePromise = this.probePreferredEngine();
    }

    const engine = await this.engineProbePromise;
    if (!engine) {
      this.engineProbePromise = undefined;
      return undefined;
    }

    this.preferredEngine = engine;
    return this.preferredEngine;
  }

  /**
   * Probes Google first and falls back to Microsoft when Google is unavailable.
   *
   */
  async probePreferredEngine() {
    const targetLanguage = getConfiguration().get("paragraphHoverTranslationTargetLanguage", "zh");
    const googleProbe = await this.translateWithGoogle(TRANSLATION_PROBE_TEXT, targetLanguage, false);
    if (googleProbe !== undefined) {
      this.output.appendLine("Paragraph translation engine: Google Translate.");
      return "google";
    }

    this.output.appendLine("Google paragraph translation is unavailable; falling back to Microsoft Translator.");
    const microsoftProbe = await this.translateWithMicrosoft(TRANSLATION_PROBE_TEXT, targetLanguage, false);
    if (microsoftProbe !== undefined) {
      this.output.appendLine("Paragraph translation engine: Microsoft Translator.");
      return "microsoft";
    }

    this.output.appendLine("No paragraph translation engine is available.");
    return undefined;
  }

  /**
   * Translates text with the selected engine.
   *
   * @param text English paragraph text.
   * @param targetLanguage Target language code.
   * @param engine Translation engine.
   */
  async translateTextWithEngine(text: string, targetLanguage: string, engine: TranslationEngine) {
    if (engine === "microsoft") {
      return this.translateWithMicrosoft(text, targetLanguage, true);
    }
    return this.translateWithGoogle(text, targetLanguage, true);
  }

  /**
   * Sends one request to Google translateHtml.
   *
   * This mirrors read-frog's unofficial Google Translate provider and avoids
   * the official paid Cloud Translation API for lightweight hover previews.
   *
   * @param text English paragraph text.
   * @param targetLanguage Target language code accepted by Google Translate.
   * @param shouldLog Whether to log failures for user-triggered translations.
   */
  async translateWithGoogle(text: string, targetLanguage: string, shouldLog: boolean) {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);

    try {
      if (shouldLog) this.logTranslationText("Google", "request", text);

      const response = await fetch(GOOGLE_TRANSLATE_HTML_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json+protobuf",
          "X-Goog-API-Key": GOOGLE_TRANSLATE_HTML_API_KEY,
        },
        body: JSON.stringify([
          [[text], "en", targetLanguage],
          GOOGLE_TRANSLATE_HTML_CLIENT,
        ]),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        if (shouldLog) {
          this.output.appendLine(`Google paragraph translation failed: ${response.status} ${response.statusText}; sourceCharacters=${text.length}`);
          this.logTranslationText("Google", "error response", errorText);
        }
        return undefined;
      }

      const result = await response.json();
      if (!Array.isArray(result) || !Array.isArray(result[0]) || typeof result[0][0] !== "string") {
        if (shouldLog) {
          this.output.appendLine("Google paragraph translation returned an unexpected response format.");
        }
        return undefined;
      }

      const translatedText = decodeHtmlText(result[0][0]).trim();
      if (shouldLog) {
        this.output.appendLine(`Google paragraph translation completed: target=${targetLanguage}; sourceCharacters=${text.length}; resultCharacters=${translatedText.length}; duration=${Date.now() - started} ms`);
        this.logTranslationText("Google", "response", translatedText);
      }
      return translatedText;
    } catch (error) {
      if (shouldLog) {
        this.output.appendLine(`Google paragraph translation failed: sourceCharacters=${text.length}; ${String(error)}`);
      }
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Sends one request to Microsoft Translator's Edge-backed free endpoint.
   *
   * This mirrors read-frog's unofficial Microsoft provider and uses the Edge
   * translate auth endpoint to obtain the short-lived token.
   *
   * @param text English paragraph text.
   * @param targetLanguage Target language code accepted by Microsoft.
   * @param shouldLog Whether to log failures for user-triggered translations.
   */
  async translateWithMicrosoft(text: string, targetLanguage: string, shouldLog: boolean, retryUnauthorized = true): Promise<string | undefined> {
    const started = Date.now();
    const token = await this.getMicrosoftToken();
    if (!token) return undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);

    try {
      if (shouldLog) this.logTranslationText("Microsoft", "request", text);
      const url = `${MICROSOFT_TRANSLATE_URL}?from=en&to=${encodeURIComponent(targetLanguage)}&api-version=3.0&includeSentenceLength=true&textType=html`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Ocp-Apim-Subscription-Key": token,
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify([{ Text: text }]),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        if (response.status === 401) {
          // Concurrent failures for an old token must not clear a newer token or its refresh.
          if (this.microsoftToken === token) {
            this.microsoftToken = undefined;
            this.microsoftTokenExpiresAt = 0;
            this.microsoftTokenPromise = undefined;
          }
          if (retryUnauthorized) {
            if (shouldLog) this.output.appendLine("Microsoft translation token was rejected; refreshing and retrying once");
            clearTimeout(timeout);
            return await this.translateWithMicrosoft(text, targetLanguage, shouldLog, false);
          }
        }
        if (shouldLog) {
          this.output.appendLine(`Microsoft paragraph translation failed: ${response.status} ${response.statusText}; sourceCharacters=${text.length}`);
          this.logTranslationText("Microsoft", "error response", errorText);
        }
        return undefined;
      }

      const result = await response.json();
      const translatedText = result && result[0] && result[0].translations && result[0].translations[0] && result[0].translations[0].text;
      if (typeof translatedText !== "string") {
        if (shouldLog) {
          this.output.appendLine("Microsoft paragraph translation returned an unexpected response format.");
        }
        return undefined;
      }

      const decoded = decodeHtmlText(translatedText).trim();
      if (shouldLog) {
        this.output.appendLine(`Microsoft paragraph translation completed: target=${targetLanguage}; sourceCharacters=${text.length}; resultCharacters=${decoded.length}; duration=${Date.now() - started} ms`);
        this.logTranslationText("Microsoft", "response", decoded);
      }
      return decoded;
    } catch (error) {
      if (shouldLog) {
        this.output.appendLine(`Microsoft paragraph translation failed: sourceCharacters=${text.length}; ${String(error)}`);
      }
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Fetches and caches the Edge translation token used by Microsoft Translator.
   *
   */
  async getMicrosoftToken() {
    if (this.microsoftToken && Date.now() < this.microsoftTokenExpiresAt) {
      return this.microsoftToken;
    }

    if (!this.microsoftTokenPromise) {
      this.microsoftToken = undefined;
      const pending = this.fetchMicrosoftToken().then((token) => {
        if (this.microsoftTokenPromise === pending) {
          this.microsoftToken = token;
          this.microsoftTokenExpiresAt = token ? microsoftTokenExpiry(token) : 0;
          this.microsoftTokenPromise = undefined;
        }
        return token;
      });
      this.microsoftTokenPromise = pending;
    }
    return this.microsoftTokenPromise;
  }

  /** Emits full source, result, and error bodies only during explicit translation debugging. */
  private logTranslationText(engine: string, phase: string, text: string): void {
    if (getConfiguration().get("debugParagraphHoverTranslation", false)) {
      this.output.appendLine(`${engine} paragraph translation ${phase} text BEGIN`);
      this.output.appendLine(text);
      this.output.appendLine(`${engine} paragraph translation ${phase} text END`);
    }
  }

  /**
   * Fetches a short-lived Microsoft Translator token from Edge.
   *
   */
  async fetchMicrosoftToken() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);

    try {
      const response = await fetch(MICROSOFT_TRANSLATE_AUTH_URL, {
        signal: controller.signal,
      });

      if (!response.ok) {
        this.output.appendLine(`Microsoft translation token refresh failed: ${response.status} ${response.statusText}`);
        return undefined;
      }

      return (await response.text()).trim();
    } catch (error) {
      this.output.appendLine(`Microsoft translation token refresh failed: ${String(error)}`);
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Decodes common HTML entities returned by translateHtml.
 *
 * @param value Translated text.
 */
function decodeHtmlText(value: string) {
  return value
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Formats source sentences as HTML blocks understood by both translators.
 *
 * @param texts Source sentence segments.
 */
function formatTranslationSegmentsHtml(texts: readonly string[]): string {
  return `<div>${texts.map((text) => `<p>${escapeTranslationHtmlText(text)}</p>`).join("")}</div>`;
}

/**
 * Recovers ordered sentence translations from protected paragraph tags.
 *
 * @param html Translated HTML fragment.
 */
function parseTranslationSegmentsHtml(html: string): string[] {
  return [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => match[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim());
}

/**
 * Escapes source text before embedding it in translator-facing HTML.
 *
 * @param value Raw source sentence.
 */
function escapeTranslationHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Uses JWT expiry as a cache hint, with a short fallback for opaque Edge tokens. */
function microsoftTokenExpiry(token: string): number {
  const fallback = Date.now() + 5 * 60_000;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? Math.min(fallback, payload.exp * 1000 - 30_000) : fallback;
  } catch {
    // Token contents only control refresh timing; authorization remains server-validated.
    return fallback;
  }
}




