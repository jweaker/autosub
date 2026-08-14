import type { AppConfig } from "./config.js";
import type { SubtitleCue } from "./domain.js";
import { requestJson } from "./http.js";
import { languageName } from "./languages.js";

interface TranslationRow {
  id: number;
  text: string;
}

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

const MAX_CUES_PER_BATCH = 120;
const MAX_CHARACTERS_PER_BATCH = 24_000;
const BATCH_TIMEOUT_MS = 60_000;
const SCHEMA_ATTEMPTS = 2;

/**
 * Last-resort translation of an already time-corrected subtitle.
 *
 * The model only ever sees cue ids and text; timestamps never leave this
 * process, so a hallucinated or reordered response can shift wording but never
 * the timing that was validated against the audio.
 */
export class GeminiTranslator {
  constructor(private readonly config: AppConfig["gemini"]) {}

  get enabled(): boolean {
    return Boolean(this.config.apiKey);
  }

  private batches(cues: SubtitleCue[]): SubtitleCue[][] {
    const result: SubtitleCue[][] = [];
    let current: SubtitleCue[] = [];
    let characters = 0;
    for (const cue of cues) {
      if (current.length >= MAX_CUES_PER_BATCH || characters + cue.text.length > MAX_CHARACTERS_PER_BATCH) {
        result.push(current);
        current = [];
        characters = 0;
      }
      current.push(cue);
      characters += cue.text.length;
    }
    if (current.length) result.push(current);
    return result;
  }

  private prompt(batch: SubtitleCue[], source: string, target: string): string {
    return [
      `Translate subtitle dialogue from ${languageName(source)} to ${languageName(target)}.`,
      "Return every cue exactly once with its unchanged numeric id. Translate naturally for on-screen subtitles, using concise lines.",
      "Preserve speaker dashes, basic HTML/italics tags, names, intentional line breaks, and bracketed sound descriptions. Do not add commentary.",
      `Cues: ${JSON.stringify(batch.map(({ id, text }) => ({ id, text })))}`,
    ].join("\n");
  }

  private async translateBatch(batch: SubtitleCue[], source: string, target: string, signal?: AbortSignal): Promise<Map<number, string>> {
    const url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.config.model)}:generateContent`);
    let lastError: unknown;

    // Transport faults are retried inside `requestJson`; this loop exists for
    // responses that arrive intact but do not satisfy the cue schema.
    for (let attempt = 1; attempt <= SCHEMA_ATTEMPTS; attempt += 1) {
      try {
        const body = await requestJson<GeminiResponse>(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": this.config.apiKey || "" },
          signal,
          timeoutMs: BATCH_TIMEOUT_MS,
          label: "Gemini translation",
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: this.prompt(batch, source, target) }] }],
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

        const text = body.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || "";
        const rows = JSON.parse(text) as TranslationRow[];
        const expected = new Set(batch.map((cue) => cue.id));
        const output = new Map<number, string>();
        for (const row of rows) {
          if (!expected.has(row.id) || typeof row.text !== "string" || !row.text.trim() || output.has(row.id)) continue;
          output.set(row.id, row.text.trim());
        }
        if (output.size !== batch.length) throw new Error(`Gemini returned ${output.size}/${batch.length} valid cue translations`);
        return output;
      } catch (error) {
        lastError = error;
        if (attempt >= SCHEMA_ATTEMPTS || signal?.aborted) break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Gemini translation failed");
  }

  async translate(cues: SubtitleCue[], source: string, target: string, signal?: AbortSignal): Promise<SubtitleCue[]> {
    if (!this.enabled) throw new Error("No Gemini API key is configured for subtitle translation");
    const batches = this.batches(cues);
    const translated = new Map<number, string>();
    // A small number of workers cuts fallback latency substantially while
    // staying gentle on API quotas. Cue ids make completion order irrelevant.
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < batches.length) {
        const batch = batches[next++];
        for (const [id, text] of await this.translateBatch(batch, source, target, signal)) translated.set(id, text);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.config.concurrency, batches.length) }, worker));
    return cues.map((cue) => ({ ...cue, text: translated.get(cue.id) || cue.text }));
  }
}
