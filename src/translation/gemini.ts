import type { SubtitleCue } from "../domain.js";
import { isTransient, requestJson } from "../http.js";
import { collectRows, parseRows, translationPrompt } from "./prompt.js";
import { assertTranslationChanged, batchCues, countCharacters, runBatchResiliently, runBatches, type TranslationUsage, type Translator } from "./types.js";

export interface GeminiSettings {
  apiKey?: string;
  model: string;
  concurrency: number;
  timeoutMs?: number;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

const MAX_CUES_PER_BATCH = 72;
const MAX_CHARACTERS_PER_BATCH = 12_000;
const BATCH_TIMEOUT_MS = 60_000;
const SCHEMA_ATTEMPTS = 2;

/**
 * Google's own API, which can constrain the answer to a schema — the strongest
 * guarantee available that every cue comes back exactly once.
 */
export class GeminiTranslator implements Translator {
  readonly name = "gemini";
  lastUsage?: TranslationUsage;
  private readonly usages = new WeakMap<SubtitleCue[], TranslationUsage>();
  private effectiveConcurrency: number;

  constructor(private readonly settings: GeminiSettings) {
    this.effectiveConcurrency = settings.concurrency;
  }

  get enabled(): boolean {
    return Boolean(this.settings.apiKey);
  }

  private async translateBatch(batch: SubtitleCue[], source: string, target: string, usage: TranslationUsage, signal?: AbortSignal): Promise<Map<number, string>> {
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.settings.model)}:generateContent`);
    let lastError: unknown;

    // Transport faults are retried inside `requestJson`; this loop exists for
    // responses that arrive intact but do not satisfy the cue schema.
    for (let attempt = 1; attempt <= SCHEMA_ATTEMPTS; attempt += 1) {
      try {
        const body = await requestJson<GeminiResponse>(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.settings.apiKey || "" },
          signal,
          timeoutMs: this.settings.timeoutMs ?? BATCH_TIMEOUT_MS,
          label: "Gemini translation",
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: translationPrompt(batch, source, target) }] }],
            generationConfig: {
              temperature: 0.15,
              responseMimeType: "application/json",
              responseJsonSchema: {
                type: "array",
                minItems: batch.length,
                maxItems: batch.length,
                items: {
                  type: "object",
                  required: ["id", "text"],
                  properties: { id: { type: "integer" }, text: { type: "string" } },
                  additionalProperties: false,
                },
              },
            },
          }),
        });

        usage.promptTokens = (usage.promptTokens || 0) + (body.usageMetadata?.promptTokenCount || 0);
        usage.responseTokens = (usage.responseTokens || 0) + (body.usageMetadata?.candidatesTokenCount || 0);
        const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
        return collectRows(batch, parseRows(text));
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw new Error("Translation aborted");
        if (isTransient(error)) throw error;
        if (attempt >= SCHEMA_ATTEMPTS) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Gemini translation failed");
  }

  async translate(cues: SubtitleCue[], source: string, target: string, signal?: AbortSignal): Promise<SubtitleCue[]> {
    if (!this.enabled) throw new Error("No Gemini API key is configured for subtitle translation");
    const usage = { characters: countCharacters(cues), promptTokens: 0, responseTokens: 0 };
    const batches = batchCues(cues, MAX_CUES_PER_BATCH, MAX_CHARACTERS_PER_BATCH);
    const translated = await runBatches(batches, this.effectiveConcurrency, (batch) => runBatchResiliently(
      batch,
      (part) => this.translateBatch(part, source, target, usage, signal),
    ), {
      onConcurrencyReduced: (concurrency) => {
        this.effectiveConcurrency = Math.min(this.effectiveConcurrency, concurrency);
      },
    });
    const result = cues.map((cue) => ({ ...cue, text: translated.get(cue.id) || cue.text }));
    assertTranslationChanged(cues, result);
    this.lastUsage = { ...usage };
    this.usages.set(result, { ...usage });
    return result;
  }

  usageFor(result: SubtitleCue[]): TranslationUsage | undefined {
    return this.usages.get(result);
  }
}
