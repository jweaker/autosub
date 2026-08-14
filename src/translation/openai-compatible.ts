import type { SubtitleCue } from "../domain.js";
import { requestJson } from "../http.js";
import { collectRows, parseRows, translationPrompt } from "./prompt.js";
import { batchCues, countCharacters, runBatches, type TranslationUsage, type Translator } from "./types.js";

export interface OpenAiCompatibleSettings {
  baseUrl?: string;
  apiKey?: string;
  model: string;
  concurrency: number;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

const MAX_CUES_PER_BATCH = 80;
const MAX_CHARACTERS_PER_BATCH = 16_000;
const BATCH_TIMEOUT_MS = 120_000;
const SCHEMA_ATTEMPTS = 2;
const SYSTEM_PROMPT = "You are a professional subtitle translator. You reply with JSON only.";

/**
 * Anything speaking the OpenAI chat-completions shape: a self-hosted model, a
 * router with a free tier, a local Ollama, a paid endpoint.
 *
 * Batches are smaller than Gemini's because smaller and free-tier models tend
 * to drop cues from long lists, and a short batch of a hundred lines is the
 * difference between a retry and a failed title.
 */
export class OpenAiCompatibleTranslator implements Translator {
  readonly name = "openai";
  lastUsage?: TranslationUsage;
  private usage: TranslationUsage = { characters: 0, promptTokens: 0, responseTokens: 0 };

  constructor(private readonly settings: OpenAiCompatibleSettings) {}

  get enabled(): boolean {
    return Boolean(this.settings.baseUrl && this.settings.model);
  }

  private endpoint(): string {
    const base = (this.settings.baseUrl || "").replace(/\/+$/, "");
    return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
  }

  private async translateBatch(batch: SubtitleCue[], source: string, target: string, signal?: AbortSignal): Promise<Map<number, string>> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= SCHEMA_ATTEMPTS; attempt += 1) {
      try {
        const body = await requestJson<ChatResponse>(this.endpoint(), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.settings.apiKey ? { Authorization: `Bearer ${this.settings.apiKey}` } : {}),
          },
          signal,
          timeoutMs: BATCH_TIMEOUT_MS,
          label: `${this.settings.model} translation`,
          body: JSON.stringify({
            model: this.settings.model,
            temperature: 0.15,
            // Honoured where supported and harmless where it is not; the parser
            // recovers JSON from prose either way.
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: `${translationPrompt(batch, source, target)}\nRespond with {"cues": [...]}.` },
            ],
          }),
        });

        this.usage.promptTokens = (this.usage.promptTokens || 0) + (body.usage?.prompt_tokens || 0);
        this.usage.responseTokens = (this.usage.responseTokens || 0) + (body.usage?.completion_tokens || 0);
        return collectRows(batch, parseRows(body.choices?.[0]?.message?.content || ""));
      } catch (error) {
        lastError = error;
        if (attempt >= SCHEMA_ATTEMPTS || signal?.aborted) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Translation failed");
  }

  async translate(cues: SubtitleCue[], source: string, target: string, signal?: AbortSignal): Promise<SubtitleCue[]> {
    if (!this.enabled) throw new Error("TRANSLATION_BASE_URL and TRANSLATION_MODEL are required for this translator");
    this.usage = { characters: countCharacters(cues), promptTokens: 0, responseTokens: 0 };
    const batches = batchCues(cues, MAX_CUES_PER_BATCH, MAX_CHARACTERS_PER_BATCH);
    const translated = await runBatches(batches, this.settings.concurrency, (batch) => this.translateBatch(batch, source, target, signal));
    this.lastUsage = { ...this.usage };
    return cues.map((cue) => ({ ...cue, text: translated.get(cue.id) || cue.text }));
  }
}
