import type { AlignmentResult, SubtitleCue, TranscriptWord, VadWindow } from "./domain.js";

const BIN_MS = 100;
const COARSE_OFFSET_STEP_MS = 2_000;
const FINE_OFFSET_STEP_MS = 50;
const FINE_RATE_STEP = 0.0001;
const COMMON_RATES = [0.95904, 0.96, 0.999, 1, 1.001, 1.041667, 1.042709];
const STOP_WORDS = new Set(["the", "and", "that", "this", "with", "from", "have", "you", "your", "for", "are", "was", "were", "but", "not", "what", "who", "how", "why", "can", "all"]);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

interface MappingScore {
  offsetMs: number;
  rate: number;
  score: number;
  windowScores: number[];
}

interface FineSearch {
  rateSpan: number;
  rateStep: number;
  offsetSpan: number;
}

const ACTIVITY_FINE: FineSearch = { rateSpan: 0.003, rateStep: 0.0005, offsetSpan: 3_000 };
const PRECISE_FINE: FineSearch = { rateSpan: 0.0015, rateStep: FINE_RATE_STEP, offsetSpan: 1_500 };

function textTokens(text: string): Set<string> {
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!normalized) return new Set();
  if (CJK.test(normalized)) {
    const compact = normalized.replace(/\s+/g, "");
    return new Set(Array.from({ length: Math.max(0, compact.length - 1) }, (_, index) => compact.slice(index, index + 2)));
  }
  return new Set(normalized.split(/\s+/).filter((token) => token.length >= 3 && !STOP_WORDS.has(token)));
}

function tokenSimilarity(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  let intersection = 0;
  for (const token of small) if (large.has(token)) intersection += 1;
  return intersection / Math.sqrt(left.size * right.size);
}

function lowerBound(values: Float64Array, target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Cue timings and tokens in a form the mapping search can query cheaply.
 *
 * The search evaluates thousands of (offset, rate) pairs, so anything that
 * depends only on the subtitle itself is computed once here. Cues are sorted by
 * start time and the longest cue duration is recorded, which lets a time range
 * be resolved with one binary search instead of a full scan per evaluation.
 */
class CueIndex {
  readonly count: number;
  readonly starts: Float64Array;
  readonly ends: Float64Array;
  private readonly order: number[];
  private readonly maxDurationMs: number;
  private tokens?: Array<Set<string>>;

  constructor(private readonly cues: SubtitleCue[]) {
    const order = cues.map((_, index) => index).sort((left, right) => cues[left].startMs - cues[right].startMs);
    this.count = cues.length;
    this.starts = new Float64Array(this.count);
    this.ends = new Float64Array(this.count);
    let maxDuration = 0;
    for (let index = 0; index < order.length; index += 1) {
      const cue = cues[order[index]];
      this.starts[index] = cue.startMs;
      this.ends[index] = cue.endMs;
      maxDuration = Math.max(maxDuration, cue.endMs - cue.startMs);
    }
    this.order = order;
    this.maxDurationMs = maxDuration;
  }

  /** First index whose cue may end at or after `fromMs`. */
  first(fromMs: number): number {
    return lowerBound(this.starts, fromMs - this.maxDurationMs);
  }

  /** One past the last index whose cue starts at or before `toMs`. */
  last(toMs: number): number {
    return lowerBound(this.starts, toMs + 1);
  }

  tokensAt(index: number): Set<string> {
    this.tokens ??= new Array(this.count);
    return (this.tokens[index] ??= textTokens(this.cues[this.order[index]].text));
  }
}

/** Per-window speech bins plus a scratch buffer reused by every evaluation. */
interface WindowIndex {
  audio: Uint8Array;
  subtitle: Uint8Array;
  transcriptTokens?: Set<string>;
  words: Array<{ word: TranscriptWord; tokens: Set<string> }>;
}

function indexWindow(window: VadWindow): WindowIndex {
  const bins = new Uint8Array(Math.ceil(window.durationMs / BIN_MS));
  for (const interval of window.speech) {
    const first = Math.max(0, Math.floor(interval.startMs / BIN_MS));
    const last = Math.min(bins.length - 1, Math.floor(interval.endMs / BIN_MS));
    for (let index = first; index <= last; index += 1) bins[index] = 1;
  }
  const words = (window.words || [])
    .filter((word) => (word.confidence ?? 1) >= 0.45)
    .map((word) => ({ word, tokens: textTokens(word.word) }));
  return {
    audio: bins,
    subtitle: new Uint8Array(bins.length),
    transcriptTokens: window.transcript ? textTokens(window.transcript) : undefined,
    words,
  };
}

// Alignment runs synchronously, so callers never observe a partially filled
// scratch buffer. Caching by identity keeps repeated candidate evaluations
// against the same audio (the common case) from re-deriving any of this.
const cueIndexes = new WeakMap<SubtitleCue[], CueIndex>();
const windowIndexes = new WeakMap<VadWindow[], WindowIndex[]>();

function cueIndexFor(cues: SubtitleCue[]): CueIndex {
  let index = cueIndexes.get(cues);
  if (!index) cueIndexes.set(cues, (index = new CueIndex(cues)));
  return index;
}

function windowIndexFor(windows: VadWindow[]): WindowIndex[] {
  let indexes = windowIndexes.get(windows);
  if (!indexes) windowIndexes.set(windows, (indexes = windows.map(indexWindow)));
  return indexes;
}

function scoreMappingInWindow(
  cues: CueIndex,
  window: VadWindow,
  state: WindowIndex,
  offsetMs: number,
  rate: number,
): number {
  const { audio, subtitle } = state;
  subtitle.fill(0);
  const absoluteStart = window.startMs;
  const absoluteEnd = absoluteStart + window.durationMs;
  const from = cues.first((absoluteStart - offsetMs) / rate);
  const to = cues.last((absoluteEnd - offsetMs) / rate);
  for (let index = from; index < to; index += 1) {
    const start = (cues.starts[index] * rate) + offsetMs;
    const end = (cues.ends[index] * rate) + offsetMs;
    if (end < absoluteStart || start > absoluteEnd) continue;
    const first = Math.max(0, Math.floor((start - absoluteStart) / BIN_MS));
    const last = Math.min(subtitle.length - 1, Math.floor((end - absoluteStart) / BIN_MS));
    for (let bin = first; bin <= last; bin += 1) subtitle[bin] = 1;
  }

  let intersection = 0;
  let subtitleCount = 0;
  let audioCount = 0;
  for (let index = 0; index < audio.length; index += 1) {
    if (subtitle[index]) subtitleCount += 1;
    if (audio[index]) audioCount += 1;
    if (subtitle[index] && audio[index]) intersection += 1;
  }
  if (subtitleCount < 4 || audioCount < 4) return 0;
  const precision = intersection / subtitleCount;
  const recall = intersection / audioCount;
  return (0.72 * precision) + (0.28 * recall);
}

function evaluateMapping(
  cues: CueIndex,
  windows: VadWindow[],
  states: WindowIndex[],
  offsetMs: number,
  rate: number,
): MappingScore {
  const windowScores = windows.map((window, index) => scoreMappingInWindow(cues, window, states[index], offsetMs, rate));
  const usable = windowScores.filter((score) => score > 0).sort((left, right) => left - right);
  if (usable.length < 3) return { offsetMs, rate, score: 0, windowScores };
  const mean = usable.reduce((sum, score) => sum + score, 0) / usable.length;
  const lowerQuartile = usable[Math.floor((usable.length - 1) * 0.25)] || 0;
  const coverage = usable.length / windows.length;
  return { offsetMs, rate, score: ((mean * 0.72) + (lowerQuartile * 0.28)) * coverage, windowScores };
}

/**
 * Coarse sweep over plausible rates and offsets, then a fine sweep around the
 * winner. `distinctiveness` is how far the winner stands above the bulk of the
 * coarse distribution, which is what separates a real match from a subtitle
 * that scores mediocre everywhere.
 */
function searchMapping(
  evaluator: (offsetMs: number, rate: number) => MappingScore,
  maxOffsetMs: number,
  fine: FineSearch,
): { best?: MappingScore; distinctiveness: number } {
  const distribution: number[] = [];
  let coarseBest: MappingScore | undefined;
  for (const rate of COMMON_RATES) {
    for (let offsetMs = -maxOffsetMs; offsetMs <= maxOffsetMs; offsetMs += COARSE_OFFSET_STEP_MS) {
      const mapping = evaluator(offsetMs, rate);
      distribution.push(mapping.score);
      if (!coarseBest || mapping.score > coarseBest.score) coarseBest = mapping;
    }
  }
  if (!coarseBest) return { distinctiveness: 0 };

  let best = coarseBest;
  const minimumRate = Math.max(0.94, coarseBest.rate - fine.rateSpan);
  const maximumRate = Math.min(1.06, coarseBest.rate + fine.rateSpan);
  const minimumOffset = Math.max(-maxOffsetMs, coarseBest.offsetMs - fine.offsetSpan);
  const maximumOffset = Math.min(maxOffsetMs, coarseBest.offsetMs + fine.offsetSpan);
  let first = true;
  for (let rate = minimumRate; rate <= maximumRate + 0.00001; rate += fine.rateStep) {
    for (let offsetMs = minimumOffset; offsetMs <= maximumOffset; offsetMs += FINE_OFFSET_STEP_MS) {
      const mapping = evaluator(offsetMs, rate);
      if (first || mapping.score > best.score) best = mapping;
      first = false;
    }
  }

  distribution.sort((left, right) => left - right);
  const baseline = distribution[Math.floor(distribution.length * 0.75)] || 0;
  return { best, distinctiveness: Math.max(0, best.score - baseline) };
}

function rejected(cues: CueIndex, mapping: MappingScore, maxOffsetMs: number, distinctiveness: number): boolean {
  const strongWindows = mapping.windowScores.filter((score) => score >= 0.32).length;
  const requiredStrongWindows = Math.max(3, Math.ceil(mapping.windowScores.length * 0.6));
  const boundary = Math.abs(mapping.offsetMs) >= maxOffsetMs - COARSE_OFFSET_STEP_MS;
  const maximumCrushedCues = Math.max(2, Math.ceil(cues.count * 0.005));
  return boundary
    || mapping.score < 0.42
    || distinctiveness < 0.025
    || strongWindows < requiredStrongWindows
    || crushedCues(cues, mapping) > maximumCrushedCues;
}

/** Cues the mapping would drag more than a second before the start of playback. */
function crushedCues(cues: CueIndex, mapping: MappingScore): number {
  const limit = ((-1_000 - mapping.offsetMs) / mapping.rate);
  return lowerBound(cues.starts, limit);
}

function resultForMapping(cues: SubtitleCue[], windows: VadWindow[], mapping: MappingScore, confidence: number): AlignmentResult {
  const aligned = cues.map((cue) => {
    const startMs = (cue.startMs * mapping.rate) + mapping.offsetMs;
    const endMs = (cue.endMs * mapping.rate) + mapping.offsetMs;
    return { ...cue, startMs: Math.max(0, startMs), endMs: Math.max(startMs + 250, endMs) };
  });
  const anchors = windows.map((window, index) => {
    const subtitleMs = (window.startMs - mapping.offsetMs) / mapping.rate;
    return {
      subtitleMs,
      offsetMs: (subtitleMs * (mapping.rate - 1)) + mapping.offsetMs,
      score: mapping.windowScores[index] || 0,
    };
  });
  const middle = cues[Math.floor(cues.length / 2)]?.startMs || 0;
  return { cues: aligned, confidence, offsetMs: Math.round((middle * (mapping.rate - 1)) + mapping.offsetMs), rate: mapping.rate, anchors };
}

const unaligned = (cues: SubtitleCue[]): AlignmentResult => ({ cues, confidence: 0, offsetMs: 0, anchors: [] });

/** Matches subtitle cue spans against the local speech-activity timeline. */
export function alignSubtitle(cues: SubtitleCue[], windows: VadWindow[], maxOffsetMs = 180_000): AlignmentResult {
  if (!cues.length || windows.length < 3) return unaligned(cues);
  const index = cueIndexFor(cues);
  const states = windowIndexFor(windows);
  const { best, distinctiveness } = searchMapping(
    (offsetMs, rate) => evaluateMapping(index, windows, states, offsetMs, rate),
    maxOffsetMs,
    ACTIVITY_FINE,
  );
  if (!best || rejected(index, best, maxOffsetMs, distinctiveness)) return unaligned(cues);

  const strongWindows = best.windowScores.filter((score) => score >= 0.32).length;
  const signal = Math.min(1, Math.max(0, (best.score - 0.32) / 0.36));
  const uniqueness = Math.min(1, distinctiveness / 0.12);
  const coverage = Math.min(1, strongWindows / 4);
  const confidence = Math.round(100 * ((signal * 0.68) + (uniqueness * 0.32)) * coverage);
  return resultForMapping(cues, windows, best, confidence);
}

/** How well transcribed word times line up with the cues they appear in. */
function wordTimingSimilarity(cues: CueIndex, window: VadWindow, state: WindowIndex, offsetMs: number, rate: number): number {
  if (state.words.length < 3) return 0;
  const windowStart = window.startMs;
  const earliest = windowStart - 2_000;
  const latest = windowStart + window.durationMs + 2_000;
  const from = cues.first((earliest - offsetMs) / rate);
  const to = cues.last((latest - offsetMs) / rate);
  let matched = 0;
  let usable = 0;
  for (const { word, tokens } of state.words) {
    if (!tokens.size) continue;
    usable += 1;
    const absoluteMs = windowStart + ((word.startMs + word.endMs) / 2);
    let best = 0;
    for (let index = from; index < to && best < 1; index += 1) {
      const startMs = (cues.starts[index] * rate) + offsetMs;
      const endMs = (cues.ends[index] * rate) + offsetMs;
      if (endMs < earliest || startMs > latest) continue;
      const cueTokens = cues.tokensAt(index);
      let sharesToken = false;
      for (const token of tokens) {
        if (cueTokens.has(token)) {
          sharesToken = true;
          break;
        }
      }
      if (!sharesToken) continue;
      const distance = absoluteMs < startMs ? startMs - absoluteMs : absoluteMs > endMs ? absoluteMs - endMs : 0;
      if (distance <= 150) best = Math.max(best, 1);
      else if (distance <= 350) best = Math.max(best, 0.78);
      else if (distance <= 700) best = Math.max(best, 0.4);
      else if (distance <= 1_200) best = Math.max(best, 0.12);
    }
    matched += best;
  }
  return usable >= 3 ? matched / usable : 0;
}

function transcriptMappingScore(
  cues: CueIndex,
  windows: VadWindow[],
  states: WindowIndex[],
  offsetMs: number,
  rate: number,
): MappingScore {
  const windowScores = windows.map((window, index) => {
    const state = states[index];
    if (!state.transcriptTokens) return 0;
    const start = window.startMs;
    const end = start + window.durationMs;
    const from = cues.first((start - offsetMs) / rate);
    const to = cues.last((end - offsetMs) / rate);
    const candidateTokens = new Set<string>();
    for (let cue = from; cue < to; cue += 1) {
      if ((cues.ends[cue] * rate) + offsetMs < start || (cues.starts[cue] * rate) + offsetMs > end) continue;
      for (const token of cues.tokensAt(cue)) candidateTokens.add(token);
    }
    const textScore = tokenSimilarity(state.transcriptTokens, candidateTokens);
    const activityScore = scoreMappingInWindow(cues, window, state, offsetMs, rate);
    const wordScore = wordTimingSimilarity(cues, window, state, offsetMs, rate);
    return wordScore > 0
      ? (textScore * 0.55) + (wordScore * 0.3) + (activityScore * 0.15)
      : (textScore * 0.76) + (activityScore * 0.24);
  });
  const available = states.filter((state) => state.transcriptTokens).length;
  const score = available ? windowScores.reduce((sum, value) => sum + value, 0) / available : 0;
  return { offsetMs, rate, score, windowScores };
}

/**
 * Matches cue text against transcribed audio. This is the strongest signal
 * available, so it is preferred whenever at least two windows transcribed.
 */
export function alignSubtitleToTranscript(cues: SubtitleCue[], windows: VadWindow[], maxOffsetMs = 180_000): AlignmentResult {
  const transcriptWindows = windows.filter((window) => window.transcript).length;
  if (transcriptWindows < 2) return alignSubtitle(cues, windows, maxOffsetMs);
  if (!cues.length) return unaligned(cues);
  const index = cueIndexFor(cues);
  const states = windowIndexFor(windows);
  const { best, distinctiveness } = searchMapping(
    (offsetMs, rate) => transcriptMappingScore(index, windows, states, offsetMs, rate),
    maxOffsetMs,
    PRECISE_FINE,
  );
  if (!best) return unaligned(cues);
  const strong = best.windowScores.filter((score) => score >= 0.14).length;
  const requiredStrong = Math.max(2, Math.ceil(transcriptWindows * 0.6));
  const invalid = Math.abs(best.offsetMs) >= maxOffsetMs - COARSE_OFFSET_STEP_MS
    || best.score < 0.18
    || distinctiveness < 0.025
    || strong < requiredStrong
    || crushedCues(index, best) > Math.max(2, Math.ceil(cues.length * 0.005));
  if (invalid) return unaligned(cues);
  const signal = Math.min(1, best.score / 0.48);
  const uniqueness = Math.min(1, distinctiveness / 0.16);
  const coverage = Math.min(1, strong / Math.max(2, transcriptWindows));
  const confidence = Math.round(100 * ((signal * 0.72) + (uniqueness * 0.28)) * coverage);
  return resultForMapping(cues, windows, best, confidence);
}

/** Cue-start index for reference alignment, cached per cue array. */
class EventIndex {
  readonly starts: Float64Array;

  constructor(cues: SubtitleCue[]) {
    this.starts = Float64Array.from(cues, (cue) => cue.startMs).sort();
  }
}

const eventIndexes = new WeakMap<SubtitleCue[], EventIndex>();

function eventIndexFor(cues: SubtitleCue[]): EventIndex {
  let index = eventIndexes.get(cues);
  if (!index) eventIndexes.set(cues, (index = new EventIndex(cues)));
  return index;
}

/**
 * Mean proximity score from every event in `from` to the nearest event in
 * `to`, both ascending and restricted to a slice. The two-pointer sweep keeps
 * this linear; a continuous falloff avoids a plateau that could leave an
 * otherwise correct subtitle a visible fraction of a second late.
 */
function proximityScore(
  from: Float64Array,
  fromStart: number,
  fromEnd: number,
  fromShift: number,
  fromRate: number,
  to: Float64Array,
  toStart: number,
  toEnd: number,
  toShift: number,
  toRate: number,
): number {
  let cursor = toStart;
  let total = 0;
  for (let index = fromStart; index < fromEnd; index += 1) {
    const value = (from[index] * fromRate) + fromShift;
    while (cursor + 1 < toEnd && (to[cursor + 1] * toRate) + toShift <= value) cursor += 1;
    let distance = Number.POSITIVE_INFINITY;
    if (cursor < toEnd) distance = Math.abs((to[cursor] * toRate) + toShift - value);
    if (cursor + 1 < toEnd) distance = Math.min(distance, Math.abs((to[cursor + 1] * toRate) + toShift - value));
    total += Math.max(0, 1 - (distance / 1_500));
  }
  return total / (fromEnd - fromStart);
}

function boundary(values: Float64Array, rate: number, shift: number, value: number): number {
  // Index of the first event mapping to `value` or later, without materializing
  // the mapped array: mapped[i] >= value  <=>  values[i] >= (value - shift)/rate.
  return lowerBound(values, (value - shift) / rate);
}

function eventSequenceScore(target: EventIndex, reference: EventIndex, offsetMs: number, rate: number): MappingScore {
  const lastTarget = target.starts.length ? (target.starts[target.starts.length - 1] * rate) + offsetMs : 0;
  const duration = Math.max(reference.starts[reference.starts.length - 1] || 0, lastTarget || 0);
  const sectionScores: number[] = [];
  for (let section = 0; section < 6; section += 1) {
    const start = duration * section / 6;
    const end = duration * (section + 1) / 6;
    const targetFrom = boundary(target.starts, rate, offsetMs, start);
    const targetTo = boundary(target.starts, rate, offsetMs, end);
    const referenceFrom = lowerBound(reference.starts, start);
    const referenceTo = lowerBound(reference.starts, end);
    if (targetTo - targetFrom < 3 || referenceTo - referenceFrom < 3) {
      sectionScores.push(0);
      continue;
    }
    const forward = proximityScore(target.starts, targetFrom, targetTo, offsetMs, rate, reference.starts, referenceFrom, referenceTo, 0, 1);
    const reverse = proximityScore(reference.starts, referenceFrom, referenceTo, 0, 1, target.starts, targetFrom, targetTo, offsetMs, rate);
    sectionScores.push((forward + reverse) / 2);
  }
  return { offsetMs, rate, score: sectionScores.reduce((sum, value) => sum + value, 0) / sectionScores.length, windowScores: sectionScores };
}

/**
 * Matches a target-language track against an already trusted timing track. Used
 * to accept a directly downloaded target subtitle instead of translating.
 */
export function alignSubtitleToReference(target: SubtitleCue[], reference: SubtitleCue[], maxOffsetMs = 180_000): AlignmentResult {
  if (target.length < 20 || reference.length < 20) return unaligned(target);
  const targetIndex = eventIndexFor(target);
  const referenceIndex = eventIndexFor(reference);
  const { best, distinctiveness } = searchMapping(
    (offsetMs, rate) => eventSequenceScore(targetIndex, referenceIndex, offsetMs, rate),
    maxOffsetMs,
    PRECISE_FINE,
  );
  if (!best) return unaligned(target);
  const strong = best.windowScores.filter((score) => score >= 0.42).length;
  const crushed = lowerBound(targetIndex.starts, (-1_000 - best.offsetMs) / best.rate);
  const invalid = Math.abs(best.offsetMs) >= maxOffsetMs - COARSE_OFFSET_STEP_MS
    || best.score < 0.5
    || distinctiveness < 0.06
    || strong < 4
    || crushed > Math.max(2, Math.ceil(target.length * 0.005));
  if (invalid) return unaligned(target);
  const confidence = Math.round(100 * Math.min(1, ((best.score - 0.35) / 0.45) * 0.75 + (distinctiveness / 0.2) * 0.25));
  const pseudoWindows: VadWindow[] = best.windowScores.map((score, index) => ({
    startMs: ((reference.at(-1)?.endMs || 0) * (index + 0.5)) / 6,
    durationMs: 0,
    speech: [],
    transcript: String(score),
  }));
  return resultForMapping(target, pseudoWindows, best, confidence);
}
