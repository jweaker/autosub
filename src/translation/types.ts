import type { SubtitleCue } from "../domain.js";

export interface TranslationUsage {
  /** Characters submitted, which is what character-billed engines charge for. */
  characters: number;
  promptTokens?: number;
  responseTokens?: number;
}

export interface Translator {
  readonly name: string;
  readonly enabled: boolean;
  /** Usage from the most recent translate() call, for cost reporting. */
  readonly lastUsage?: TranslationUsage;
  translate(cues: SubtitleCue[], source: string, target: string, signal?: AbortSignal): Promise<SubtitleCue[]>;
}

/**
 * Splits cues into request-sized groups.
 *
 * Language models do better with many cues at once because neighbouring lines
 * are the only context a subtitle fragment has; character-billed engines have
 * hard per-request array limits instead.
 */
export function batchCues(cues: SubtitleCue[], maxCues: number, maxCharacters: number): SubtitleCue[][] {
  const batches: SubtitleCue[][] = [];
  let current: SubtitleCue[] = [];
  let characters = 0;
  for (const cue of cues) {
    if (current.length >= maxCues || (current.length && characters + cue.text.length > maxCharacters)) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    current.push(cue);
    characters += cue.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** Runs batches with a small amount of concurrency, preserving cue identity. */
export async function runBatches(
  batches: SubtitleCue[][],
  concurrency: number,
  work: (batch: SubtitleCue[]) => Promise<Map<number, string>>,
): Promise<Map<number, string>> {
  const translated = new Map<number, string>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const batch = batches[next++];
      for (const [id, text] of await work(batch)) translated.set(id, text);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, worker));
  return translated;
}

export const countCharacters = (cues: SubtitleCue[]): number =>
  cues.reduce((total, cue) => total + cue.text.length, 0);
