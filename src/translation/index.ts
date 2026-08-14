import type { AppConfig } from "../config.js";
import { GeminiTranslator } from "./gemini.js";
import { DeepLTranslator, LibreTranslateTranslator } from "./machine.js";
import { OpenAiCompatibleTranslator } from "./openai-compatible.js";
import type { Translator } from "./types.js";

export type { Translator, TranslationUsage } from "./types.js";
export { GeminiTranslator } from "./gemini.js";
export { OpenAiCompatibleTranslator } from "./openai-compatible.js";
export { DeepLTranslator, LibreTranslateTranslator } from "./machine.js";

/**
 * Picks the configured translation backend.
 *
 * Translation only ever runs when no real subtitle could be validated, so the
 * right engine is a matter of what the operator is willing to pay and host —
 * hence a choice rather than a hardcoded vendor.
 */
export function createTranslator(config: AppConfig): Translator {
  const { translation } = config;
  const shared = { concurrency: translation.concurrency, apiKey: translation.apiKey, baseUrl: translation.baseUrl };
  switch (translation.provider) {
    case "openai":
      return new OpenAiCompatibleTranslator({ ...shared, model: translation.model, timeoutMs: translation.timeoutMs });
    case "deepl":
      return new DeepLTranslator(shared);
    case "libretranslate":
      return new LibreTranslateTranslator(shared);
    default:
      return new GeminiTranslator({
        apiKey: translation.apiKey || config.gemini.apiKey,
        model: translation.model || config.gemini.model,
        concurrency: translation.concurrency,
      });
  }
}
