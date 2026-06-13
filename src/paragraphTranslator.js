"use strict";

const { getConfiguration } = require("./configuration");

const GOOGLE_TRANSLATE_HTML_URL = "https://translate-pa.googleapis.com/v1/translateHtml";
const GOOGLE_TRANSLATE_HTML_API_KEY = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";
const GOOGLE_TRANSLATE_HTML_CLIENT = "wt_lib";

class GoogleParagraphTranslator {
  /**
   * Creates a small Google Translate client for paragraph hover previews.
   *
   * @param {vscode.OutputChannel} output Output channel for translation failures.
   */
  constructor(output) {
    this.output = output;
    this.translationCache = new Map();
  }

  /**
   * Translates one short English paragraph to the configured target language.
   *
   * @param {string} text English paragraph text.
   * @returns {Promise<string | undefined>}
   */
  async translateText(text) {
    if (!text) {
      return "";
    }

    const targetLanguage = getConfiguration().get("paragraphHoverTranslationTargetLanguage", "zh");
    const cacheKey = `${targetLanguage}:${text}`;
    if (!this.translationCache.has(cacheKey)) {
      this.translationCache.set(cacheKey, this.translateTextUncached(text, targetLanguage));
    }

    return this.translationCache.get(cacheKey);
  }

  /**
   * Sends one request to Google translateHtml.
   *
   * This mirrors read-frog's unofficial Google Translate provider and avoids
   * the official paid Cloud Translation API for lightweight hover previews.
   *
   * @param {string} text English paragraph text.
   * @param {string} targetLanguage Target language code accepted by Google Translate.
   * @returns {Promise<string | undefined>}
   */
  async translateTextUncached(text, targetLanguage) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

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
        this.output.appendLine(`Google paragraph translation failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`);
        return undefined;
      }

      const result = await response.json();
      if (!Array.isArray(result) || !Array.isArray(result[0]) || typeof result[0][0] !== "string") {
        this.output.appendLine("Google paragraph translation returned an unexpected response format.");
        return undefined;
      }

      return decodeHtmlText(result[0][0]).trim();
    } catch (error) {
      this.output.appendLine(`Google paragraph translation failed for ${formatTranslationTextForLog(text)}: ${String(error)}`);
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
function decodeHtmlText(value) {
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
function formatTranslationTextForLog(text) {
  const compactText = text.replace(/\s+/g, " ").trim();
  const truncatedText = compactText.length > 120 ? `${compactText.slice(0, 117)}...` : compactText;
  return `"${truncatedText}"`;
}


module.exports = {
  GoogleParagraphTranslator,
};
