import type { SubtitleCue } from "../domain.js";
import { HttpError, isTransient } from "../http.js";

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
  /** Per-result usage, safe when multiple titles translate concurrently. */
  usageFor?(result: SubtitleCue[]): TranslationUsage | undefined;
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
      // Prefer a nearby scene pause over cutting a sentence exchange at the
      // exact numeric limit. Keep the search local so batch sizes stay bounded.
      let split = current.length;
      for (let index = current.length - 1; index >= Math.max(1, current.length - 12); index -= 1) {
        if (current[index].startMs - current[index - 1].endMs >= 2_500) {
          split = index;
          break;
        }
      }
      batches.push(current.slice(0, split));
      current = current.slice(split);
      characters = current.reduce((total, item) => total + item.text.length, 0);
    }
    current.push(cue);
    characters += cue.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

export interface BatchRunOptions {
  /** Number of scheduler-level attempts for a batch after transport retries. */
  attempts?: number;
  /** Initial pause after endpoint backpressure. Primarily shortened in tests. */
  retryDelayMs?: number;
  /** Lets a long-lived translator remember the endpoint's working limit. */
  onConcurrencyReduced?: (concurrency: number) => void;
}

interface PendingBatch {
  batch: SubtitleCue[];
  attempts: number;
}

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Runs independent batches concurrently while adapting to endpoint pressure.
 *
 * A gateway with a concurrency limit commonly accepts one request and rejects
 * the other workers with 429. Waiting for the accepted work, preserving it,
 * then halving only the remaining parallelism makes the title finish without
 * restarting paid batches or making every future title sequential.
 */
export async function runBatches(
  batches: SubtitleCue[][],
  concurrency: number,
  work: (batch: SubtitleCue[]) => Promise<Map<number, string>>,
  options: BatchRunOptions = {},
): Promise<Map<number, string>> {
  const translated = new Map<number, string>();
  const maximumAttempts = Math.max(1, options.attempts ?? 5);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);
  let limit = Math.max(1, Math.min(concurrency, batches.length));
  let pending: PendingBatch[] = batches.map((batch) => ({ batch, attempts: 0 }));

  while (pending.length) {
    let next = 0;
    let halted = false;
    const failures: Array<{ item: PendingBatch; error: unknown }> = [];
    const worker = async (): Promise<void> => {
      while (!halted && next < pending.length) {
        const item = pending[next++];
        try {
          for (const [id, text] of await work(item.batch)) translated.set(id, text);
        } catch (error) {
          failures.push({ item, error });
          halted = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, pending.length) }, worker));

    const nonTransient = failures.find(({ error }) => !isTransient(error));
    if (nonTransient) throw nonTransient.error;
    if (!failures.length) {
      pending = pending.slice(next);
      continue;
    }

    const retried = failures.map(({ item, error }) => ({ item: { ...item, attempts: item.attempts + 1 }, error }));
    const longQuota = retried.find(({ error }) => error instanceof HttpError && (error.retryAfterMs || 0) > 30_000);
    if (longQuota) throw longQuota.error;
    const exhausted = retried.find(({ item }) => item.attempts >= maximumAttempts);
    if (exhausted) throw exhausted.error;
    pending = [...retried.map(({ item }) => item), ...pending.slice(next)];

    const reduced = Math.max(1, Math.floor(limit / 2));
    if (reduced < limit) {
      console.warn(`Translation endpoint applied backpressure; reducing parallel workers from ${limit} to ${reduced}`);
      limit = reduced;
      options.onConcurrencyReduced?.(limit);
    }
    const requested = Math.max(0, ...retried.map(({ error }) => error instanceof HttpError ? error.retryAfterMs || 0 : 0));
    const round = Math.max(...retried.map(({ item }) => item.attempts));
    await wait(requested || Math.min(30_000, retryDelayMs * 2 ** (round - 1)));
  }
  return translated;
}

/**
 * A malformed long model response should cost a smaller retry, not the film.
 * Schema-constrained models still occasionally truncate a large JSON array;
 * recursively splitting only that failed batch preserves context elsewhere and
 * stays inside runBatches' configured worker count.
 */
export async function runBatchResiliently(
  batch: SubtitleCue[],
  work: (batch: SubtitleCue[]) => Promise<Map<number, string>>,
  minimumSplitSize = 12,
): Promise<Map<number, string>> {
  try {
    return await work(batch);
  } catch (error) {
    // Transport and capacity failures do not become more recoverable when the
    // payload is split. Let runBatches reduce pressure and retry the same work.
    if (isTransient(error)) throw error;
    if (batch.length <= minimumSplitSize) throw error;
    const middle = Math.ceil(batch.length / 2);
    const left = await runBatchResiliently(batch.slice(0, middle), work, minimumSplitSize);
    const right = await runBatchResiliently(batch.slice(middle), work, minimumSplitSize);
    return new Map([...left, ...right]);
  }
}

/** Refuses a model that merely echoed a substantial part of the source. */
export function assertTranslationChanged(source: SubtitleCue[], translated: SubtitleCue[]): void {
  const normalize = (text: string): string => text
    .normalize("NFKC")
    .replace(/<[^>]+>/g, "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const comparable = source.filter((cue) => /\p{L}{4}/u.test(cue.text));
  if (comparable.length < 10) return;
  const byId = new Map(translated.map((cue) => [cue.id, normalize(cue.text)]));
  const unchanged = comparable.filter((cue) => byId.get(cue.id) === normalize(cue.text)).length;
  if (unchanged / comparable.length > 0.25) {
    throw new Error(`Translation left ${unchanged}/${comparable.length} dialogue cues unchanged`);
  }
}

export const countCharacters = (cues: SubtitleCue[]): number =>
  cues.reduce((total, cue) => total + cue.text.length, 0);
