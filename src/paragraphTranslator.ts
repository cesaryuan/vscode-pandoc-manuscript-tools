import type * as vscode from "vscode";
import { getConfiguration } from "./configuration";

const GOOGLE_TRANSLATE_HTML_URL = "https://translate-pa.googleapis.com/v1/translateHtml";
const GOOGLE_TRANSLATE_HTML_API_KEY = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";
const GOOGLE_TRANSLATE_HTML_CLIENT = "wt_lib";
const MICROSOFT_TRANSLATE_AUTH_URL = "https://edge.microsoft.com/translate/auth";
const MICROSOFT_TRANSLATE_URL = "https://api-edge.cognitive.microsofttranslator.com/translate";
const TRANSLATION_TIMEOUT_MS = 5000;
const TRANSLATION_PROBE_TEXT = "Library";

export type TranslationEngine = "google" | "microsoft";
export type TranslationResult = { text: string; engine: TranslationEngine };

export class ParagraphTranslator {
  declare output: import("vscode").OutputChannel;
  declare translationCache: Map<string, Promise<TranslationResult | undefined>>;
  declare preferredEngine: TranslationEngine | undefined;
  declare engineProbePromise: Promise<TranslationEngine | undefined> | undefined;
  declare microsoftToken: string | undefined;
  declare microsoftTokenPromise: Promise<string | undefined> | undefined;
  /**
   * Creates a small translator for paragraph hover previews.
   *
   * @param {vscode.OutputChannel} output Output channel for translation failures.
   */
  constructor(output: vscode.OutputChannel) {
    this.output = output;
    this.translationCache = new Map();
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
   * @returns {Promise<void>}
   */
  async initialize() {
    await this.ensurePreferredEngine();
  }

  /**
   * Translates one short English paragraph to the configured target language.
   *
   * @param {string} text English paragraph text.
   * @returns {Promise<TranslationResult | undefined>}
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
    if (!this.translationCache.has(cacheKey)) {
      this.translationCache.set(cacheKey, this.translateTextWithEngine(text, targetLanguage, engine)
        .then((translatedText) => translatedText === undefined ? undefined : { text: translatedText, engine }));
    }

    return this.translationCache.get(cacheKey);
  }

  /**
   * Returns the preferred translation engine, probing once if needed.
   *
   * @returns {Promise<TranslationEngine | undefined>}
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
   * @returns {Promise<TranslationEngine | undefined>}
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
   * @param {string} text English paragraph text.
   * @param {string} targetLanguage Target language code.
   * @param {TranslationEngine} engine Translation engine.
   * @returns {Promise<string | undefined>}
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
   * @param {string} text English paragraph text.
   * @param {string} targetLanguage Target language code accepted by Google Translate.
   * @param {boolean} shouldLog Whether to log failures for user-triggered translations.
   * @returns {Promise<string | undefined>}
   */
  async translateWithGoogle(text: string, targetLanguage: string, shouldLog: boolean) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);

    try {
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
          this.output.appendLine(`Google paragraph translation failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`);
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

      return decodeHtmlText(result[0][0]).trim();
    } catch (error) {
      if (shouldLog) {
        this.output.appendLine(`Google paragraph translation failed for ${formatTranslationTextForLog(text)}: ${String(error)}`);
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
   * @param {string} text English paragraph text.
   * @param {string} targetLanguage Target language code accepted by Microsoft.
   * @param {boolean} shouldLog Whether to log failures for user-triggered translations.
   * @returns {Promise<string | undefined>}
   */
  async translateWithMicrosoft(text: string, targetLanguage: string, shouldLog: boolean) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT_MS);

    try {
      const token = await this.getMicrosoftToken();
      if (!token) {
        return undefined;
      }

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
        if (shouldLog) {
          this.output.appendLine(`Microsoft paragraph translation failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`);
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

      return decodeHtmlText(translatedText).trim();
    } catch (error) {
      if (shouldLog) {
        this.output.appendLine(`Microsoft paragraph translation failed for ${formatTranslationTextForLog(text)}: ${String(error)}`);
      }
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Fetches and caches the Edge translation token used by Microsoft Translator.
   *
   * @returns {Promise<string | undefined>}
   */
  async getMicrosoftToken() {
    if (this.microsoftToken) {
      return this.microsoftToken;
    }

    if (!this.microsoftTokenPromise) {
      this.microsoftTokenPromise = this.fetchMicrosoftToken();
    }

    const token = await this.microsoftTokenPromise;
    if (!token) {
      this.microsoftTokenPromise = undefined;
      return undefined;
    }

    this.microsoftToken = token;
    return this.microsoftToken;
  }

  /**
   * Fetches a short-lived Microsoft Translator token from Edge.
   *
   * @returns {Promise<string | undefined>}
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
 * @param {string} value Translated text.
 * @returns {string}
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
 * Formats translation text compactly for one-line output-channel diagnostics.
 *
 * @param {string} text Source text.
 * @returns {string}
 */
function formatTranslationTextForLog(text: string) {
  const compactText = text.replace(/\s+/g, " ").trim();
  const truncatedText = compactText.length > 120 ? `${compactText.slice(0, 117)}...` : compactText;
  return `"${truncatedText}"`;
}



/**
 * @typedef {TranslationResult} TranslationResult
 */

