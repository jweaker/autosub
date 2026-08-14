import type { SubtitleCue } from "../domain.js";
import { requestJson } from "../http.js";
import { normalizeLanguage } from "../languages.js";
import { batchCues, countCharacters, runBatches, type TranslationUsage, type Translator } from "./types.js";

export interface MachineSettings {
  apiKey?: string;
  baseUrl?: string;
  concurrency: number;
}

const MAX_TEXTS_PER_REQUEST = 50;
const MAX_CHARACTERS_PER_REQUEST = 20_000;
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Classic machine translation: one request, an array of strings in, an array
 * of strings out.
 *
 * No prompt, no schema, no chance of a model dropping or reordering cues —
 * position is the contract — which makes it the most predictable option, and
 * the only one that can be billed per character or self-hosted for nothing.
 * The tradeoff is context: each line is translated on its own.
 */
abstract class ArrayTranslator implements Translator {
  abstract readonly name: string;
  lastUsage?: TranslationUsage;

  constructor(protected readonly settings: MachineSettings) {}

  abstract get enabled(): boolean;
  protected abstract send(texts: string[], source: string, target: string, signal?: AbortSignal): Promise<string[]>;

  async translate(cues: SubtitleCue[], source: string, target: string, signal?: AbortSignal): Promise<SubtitleCue[]> {
    if (!this.enabled) throw new Error(`${this.name} is not configured for subtitle translation`);
    const batches = batchCues(cues, MAX_TEXTS_PER_REQUEST, MAX_CHARACTERS_PER_REQUEST);
    const translated = await runBatches(batches, this.settings.concurrency, async (batch) => {
      const results = await this.send(batch.map((cue) => cue.text), source, target, signal);
      if (results.length !== batch.length) throw new Error(`${this.name} returned ${results.length}/${batch.length} translations`);
      return new Map(batch.map((cue, index) => [cue.id, results[index].trim() || cue.text]));
    });
    this.lastUsage = { characters: countCharacters(cues) };
    return cues.map((cue) => ({ ...cue, text: translated.get(cue.id) || cue.text }));
  }
}

/** DeepL, whose free tier covers a handful of titles a month. */
export class DeepLTranslator extends ArrayTranslator {
  readonly name = "deepl";

  get enabled(): boolean {
    return Boolean(this.settings.apiKey);
  }

  protected async send(texts: string[], source: string, target: string, signal?: AbortSignal): Promise<string[]> {
    // Free keys end in ":fx" and are served from a different host.
    const base = this.settings.baseUrl
      || (this.settings.apiKey?.endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com");
    const body = await requestJson<{ translations?: Array<{ text?: string }> }>(`${base.replace(/\/+$/, "")}/v2/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `DeepL-Auth-Key ${this.settings.apiKey}` },
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      label: "DeepL translation",
      body: JSON.stringify({
        text: texts,
        source_lang: (normalizeLanguage(source) || source).toUpperCase(),
        target_lang: (normalizeLanguage(target) || target).toUpperCase(),
        preserve_formatting: true,
      }),
    });
    return (body.translations || []).map((entry) => entry.text || "");
  }
}

/** LibreTranslate, which can be self-hosted and then costs nothing at all. */
export class LibreTranslateTranslator extends ArrayTranslator {
  readonly name = "libretranslate";

  get enabled(): boolean {
    return Boolean(this.settings.baseUrl);
  }

  protected async send(texts: string[], source: string, target: string, signal?: AbortSignal): Promise<string[]> {
    const body = await requestJson<{ translatedText?: string[] | string }>(`${(this.settings.baseUrl || "").replace(/\/+$/, "")}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      label: "LibreTranslate translation",
      body: JSON.stringify({
        q: texts,
        source: normalizeLanguage(source) || source,
        target: normalizeLanguage(target) || target,
        format: "text",
        ...(this.settings.apiKey ? { api_key: this.settings.apiKey } : {}),
      }),
    });
    return Array.isArray(body.translatedText) ? body.translatedText : [String(body.translatedText || "")];
  }
}
