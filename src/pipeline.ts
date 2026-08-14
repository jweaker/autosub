import { alignSubtitleToReference, alignSubtitleToTranscript } from "./alignment.js";
import { AudioAnalyzer } from "./audio.js";
import { stableKey, SubtitleCache } from "./cache.js";
import type { AppConfig } from "./config.js";
import type { AudioProbeResult, CompletedSubtitle, RankedCandidate, StreamRecord, SubtitleCandidate, SubtitleCue, SubtitleProvider, SubtitleRequest } from "./domain.js";
import { normalizeLanguage } from "./languages.js";
import { MetadataService } from "./metadata.js";
import { rankCandidates } from "./ranking.js";
import { parseSrt, serializeSrt } from "./srt.js";
import { prepareSubtitle } from "./subtitle-content.js";
import { GeminiTranslator } from "./translation.js";

/** Cache key version; bump when a change should invalidate stored subtitles. */
const CACHE_VERSION = 8;
const PROBE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHED_PROBES = 12;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const CANDIDATES_PER_WAVE = 3;
const DOWNLOAD_REUSE_MS = 60_000;
const MAX_TRACKED_RUNS = 25;

export interface RunSummary {
  at: string;
  contentId: string;
  language: string;
  outcome: "cached" | "direct" | "translated" | "failed";
  provider?: string;
  confidence?: number;
  release?: string;
  totalMs: number;
  stages: Record<string, number>;
}

interface Evaluated {
  ranked: RankedCandidate;
  content: string;
  confidence: number;
  offsetMs: number;
  rate?: number;
}

type Aligner = (cues: SubtitleCue[]) => { cues: SubtitleCue[]; confidence: number; offsetMs: number; rate?: number };

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Turns "a user pressed play on this release" into one trusted subtitle.
 *
 * The ordering matters: audio analysis and provider searches start together,
 * the source-language track is validated against the transcript first, and the
 * target language is only accepted if it matches that trusted timing.
 */
export class AutoSubPipeline {
  private readonly audio: AudioAnalyzer;
  private readonly metadata: MetadataService;
  private readonly translator: GeminiTranslator;
  private readonly cache: SubtitleCache;
  private readonly byName: Map<string, SubtitleProvider>;
  private readonly downloads = new Map<string, Promise<Uint8Array>>();
  private readonly probes = new Map<string, { probe: Promise<AudioProbeResult>; at: number }>();
  private readonly runs: RunSummary[] = [];

  constructor(
    private readonly config: AppConfig,
    private readonly providers: SubtitleProvider[],
    cache = new SubtitleCache(config.dataDir),
  ) {
    this.audio = new AudioAnalyzer(config);
    this.metadata = new MetadataService(config.tmdbToken);
    this.translator = new GeminiTranslator(config.gemini);
    this.cache = cache;
    this.byName = new Map(providers.map((provider) => [provider.name, provider]));
  }

  /** Searches every provider at once; a provider that fails is logged, not fatal. */
  private async search(request: SubtitleRequest, languages: string[]): Promise<SubtitleCandidate[]> {
    if (!languages.length || !this.providers.length) return [];
    const query = { ...request, languages };
    // Providers retry internally; this budget bounds the whole attempt so one
    // slow API cannot hold up the wave.
    const budgetMs = this.config.providerTimeoutMs * 3;
    const settled = await Promise.allSettled(this.providers.map(async (provider) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budgetMs);
      try {
        return await provider.search(query, controller.signal);
      } finally {
        clearTimeout(timer);
      }
    }));

    const unique = new Map<string, SubtitleCandidate>();
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      if (result.status === "rejected") {
        console.warn(`${this.providers[index].name} search failed:`, describe(result.reason));
        continue;
      }
      for (const candidate of result.value) unique.set(`${candidate.provider}:${candidate.providerId}`, candidate);
    }
    return [...unique.values()];
  }

  /**
   * Picks the next wave of candidates: the best remaining entry from as many
   * distinct providers as possible. Besides being faster than one-at-a-time,
   * this avoids burning several OpenSubtitles download credits on
   * near-identical files before another provider gets a chance.
   */
  private nextWave(remaining: RankedCandidate[]): RankedCandidate[] {
    const providers = new Set<string>();
    const wave: RankedCandidate[] = [];
    for (let index = 0; index < remaining.length && wave.length < CANDIDATES_PER_WAVE;) {
      const item = remaining[index];
      if (providers.has(item.candidate.provider)) {
        index += 1;
        continue;
      }
      providers.add(item.candidate.provider);
      wave.push(item);
      remaining.splice(index, 1);
    }
    if (!wave.length && remaining.length) wave.push(remaining.shift() as RankedCandidate);
    return wave;
  }

  /**
   * Starts downloading the candidates that are about to be evaluated anyway.
   *
   * These are the same files the first wave would fetch, so this costs no extra
   * provider quota; it just moves the transfer off the critical path while the
   * source track is still being validated.
   */
  private prefetch(request: SubtitleRequest, candidates: SubtitleCandidate[], excluded: Set<string>): void {
    const usable = candidates.filter((candidate) => !excluded.has(variantId(candidate)));
    for (const ranked of rankCandidates(request, usable).slice(0, CANDIDATES_PER_WAVE)) {
      void this.download(ranked.candidate).catch(() => undefined);
    }
  }

  private download(candidate: SubtitleCandidate): Promise<Uint8Array> {
    const id = variantId(candidate);
    const pending = this.downloads.get(id);
    if (pending) return pending;
    const provider = this.byName.get(candidate.provider);
    if (!provider) return Promise.reject(new Error(`Unknown provider ${candidate.provider}`));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    const attempt = provider.download(candidate, controller.signal).finally(() => {
      clearTimeout(timer);
      // Only the in-flight transfer is shared; the bytes are not kept around.
      setTimeout(() => this.downloads.delete(id), DOWNLOAD_REUSE_MS).unref?.();
    });
    this.downloads.set(id, attempt);
    return attempt;
  }

  private async evaluateCandidate(item: RankedCandidate, align: Aligner): Promise<Evaluated | undefined> {
    if (!this.byName.has(item.candidate.provider)) return undefined;
    try {
      const raw = await this.download(item.candidate);
      const aligned = align(parseSrt(prepareSubtitle(raw, item.candidate)));
      return {
        ranked: item,
        content: serializeSrt(aligned.cues),
        confidence: aligned.confidence,
        offsetMs: aligned.offsetMs,
        rate: aligned.rate,
      };
    } catch (error) {
      console.warn(`${item.candidate.provider} candidate ${item.candidate.providerId} failed:`, describe(error));
      return undefined;
    }
  }

  /** Downloads and validates candidates in waves, stopping at the first confident match. */
  private async evaluate(
    request: SubtitleRequest,
    candidates: SubtitleCandidate[],
    align: Aligner,
    excluded: Set<string>,
  ): Promise<Evaluated | undefined> {
    const usable = candidates.filter((candidate) => !excluded.has(variantId(candidate)));
    const remaining = rankCandidates(request, usable).slice(0, this.config.candidateLimit);
    const accepted: Evaluated[] = [];
    while (remaining.length) {
      const wave = this.nextWave(remaining);
      const results = await Promise.all(wave.map((item) => this.evaluateCandidate(item, align)));
      for (const result of results) {
        if (result && result.confidence >= this.config.minimumConfidence) accepted.push(result);
      }
      if (accepted.length) break;
    }
    // Confidence dominates, but release-name ranking breaks near-ties.
    const weight = (item: Evaluated): number => (item.confidence * 0.82) + (item.ranked.score * 0.18);
    return accepted.sort((left, right) => weight(right) - weight(left))[0];
  }

  private cacheKey(request: SubtitleRequest, stream: StreamRecord, target: string, excluded: string[]): string {
    return stableKey({
      version: CACHE_VERSION,
      // Rejected variants are part of the identity of the answer: the same
      // release asked again after a rejection is a different question.
      excluded: [...excluded].sort(),
      type: request.type,
      id: request.contentId,
      hash: request.videoHash,
      size: request.videoSize,
      filename: request.filename,
      streamFingerprint: streamFingerprint(request, stream),
      target,
      geminiModel: this.config.gemini.model,
    });
  }

  /** Fingerprint of the release itself, stable across rejections. */
  releaseKey(request: SubtitleRequest, stream: StreamRecord, targetLanguage: string): string {
    return stableKey({
      type: request.type,
      id: request.contentId,
      streamFingerprint: streamFingerprint(request, stream),
      target: normalizeLanguage(targetLanguage) || targetLanguage,
    });
  }

  private async store(result: CompletedSubtitle): Promise<CompletedSubtitle> {
    try {
      await this.cache.put(result);
    } catch (error) {
      // A cache write failure only costs time on the next play.
      console.warn("Could not cache subtitle:", describe(error));
    }
    return result;
  }

  /**
   * @param excludeIds Variant ids the viewer already rejected. A rejected
   * translation also bars its source track, because reusing that track would
   * produce the same translation again.
   */
  async complete(
    originalRequest: SubtitleRequest,
    stream: StreamRecord,
    targetLanguage: string,
    excludeIds: string[] = [],
  ): Promise<CompletedSubtitle> {
    const started = Date.now();
    const target = normalizeLanguage(targetLanguage) || targetLanguage;
    const request: SubtitleRequest = {
      ...originalRequest,
      filename: originalRequest.filename || stream.filename,
      videoHash: originalRequest.videoHash || stream.videoHash,
      videoSize: originalRequest.videoSize || stream.videoSize,
      languages: [target],
    };
    const excluded = new Set(excludeIds.map((id) => (id.startsWith(TRANSLATED_PREFIX) ? id.slice(TRANSLATED_PREFIX.length) : id)));
    const key = this.cacheKey(request, stream, target, excludeIds);
    const stages: Record<string, number> = {};
    const mark = <T>(stage: string, work: Promise<T>): Promise<T> => {
      const from = Date.now();
      return work.finally(() => {
        stages[stage] = Date.now() - from;
      });
    };
    const summary = (outcome: RunSummary["outcome"], result?: CompletedSubtitle): void => this.record({
      at: new Date().toISOString(),
      contentId: request.contentId,
      language: target,
      outcome,
      provider: result?.provider,
      confidence: result?.confidence,
      release: request.filename,
      totalMs: Date.now() - started,
      stages,
    });

    const cached = await this.cache.get(key);
    if (cached) {
      summary("cached", cached);
      return cached;
    }
    if (!this.config.audioAnalysisEnabled) throw new Error("Audio analysis is disabled; refusing to guess a subtitle");
    if (excludeIds.length) console.log(`Preparing ${target} for ${request.contentId} while skipping ${excludeIds.length} rejected subtitle(s)`);

    const metadataLanguage = await mark("metadata", this.metadata.originalLanguage(request.imdbId, request.type));
    const initialSourceLanguages = normalizedSet([metadataLanguage, ...this.config.referenceLanguages]);

    // Audio analysis and the provider searches are independent; overlapping
    // them removes several seconds from every cold start.
    const analysisPromise = mark("audio", this.analyze(stream, metadataLanguage));
    const initialSourcePromise = mark("search", this.search(request, initialSourceLanguages));
    const targetPromise = initialSourceLanguages.includes(target)
      ? initialSourcePromise
      : mark("searchTarget", this.search(request, [target]));

    const probe = await analysisPromise;
    const sourceLanguages = normalizedSet([...initialSourceLanguages, probe.audioLanguage]);
    if (!sourceLanguages.length) throw new Error("Could not determine the original audio language");

    const missing = sourceLanguages.filter((language) => !initialSourceLanguages.includes(language));
    const [initialSource, additionalSource, targetCandidates] = await Promise.all([
      initialSourcePromise,
      this.search(request, missing),
      targetPromise,
    ]);

    // The target files are needed next in almost every run; fetching them now
    // overlaps their transfer with validating the source track.
    if (!sourceLanguages.includes(target)) this.prefetch(request, targetCandidates, excluded);

    const source = await mark("validateSource", this.evaluate(
      request,
      [...initialSource, ...additionalSource],
      (cues) => alignSubtitleToTranscript(cues, probe.windows, this.config.maxSyncOffsetSeconds * 1000),
      excluded,
    ));
    if (!source) {
      summary("failed");
      throw new Error(`No subtitle in ${sourceLanguages.join(", ")} matched the transcribed audio`);
    }
    log("Trusted timing", source, probe, started, stages);

    if (sourceLanguages.includes(target)) {
      const result = await this.store({
        key,
        id: variantId(source.ranked.candidate),
        language: target,
        content: source.content,
        confidence: source.confidence,
        provider: source.ranked.candidate.provider,
        translated: false,
      });
      summary("direct", result);
      return result;
    }

    const referenceCues = parseSrt(source.content);
    const direct = await mark("validateTarget", this.evaluate(
      request,
      targetCandidates,
      (cues) => alignSubtitleToReference(cues, referenceCues, this.config.maxSyncOffsetSeconds * 1000),
      excluded,
    ));
    if (direct) {
      log(`Direct ${target} subtitle`, direct, probe, started, stages);
      const result = await this.store({
        key,
        id: variantId(direct.ranked.candidate),
        language: target,
        content: direct.content,
        confidence: Math.min(source.confidence, direct.confidence),
        provider: direct.ranked.candidate.provider,
        translated: false,
      });
      summary("direct", result);
      return result;
    }

    const sourceLanguage = normalizeLanguage(source.ranked.candidate.language) || sourceLanguages[0];
    console.log(`No direct ${target} timing match; translating trusted ${sourceLanguage} timing with ${this.config.gemini.model}`);
    const translated = await mark("translate", this.translator.translate(referenceCues, sourceLanguage, target));
    const result = await this.store({
      key,
      id: `${TRANSLATED_PREFIX}${variantId(source.ranked.candidate)}`,
      language: target,
      content: serializeSrt(translated),
      confidence: source.confidence,
      provider: `${source.ranked.candidate.provider}+gemini`,
      translated: true,
      sourceLanguage,
    });
    summary("translated", result);
    return result;
  }

  /**
   * Audio analysis is by far the slowest step, and "try another" asks the same
   * questions of the same audio, so a probe is kept in memory for the release.
   * Reusing the object also reuses the aligner's per-window precomputation.
   */
  private analyze(stream: StreamRecord, metadataLanguage: string | undefined): Promise<AudioProbeResult> {
    const key = stream.videoHash || stream.url;
    const cached = this.probes.get(key);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.probe;
    // The promise is cached, not the result, so two languages starting together
    // share one ffmpeg pass instead of racing to make the same one.
    const probe = this.audio.analyze(stream, metadataLanguage);
    this.probes.set(key, { probe, at: Date.now() });
    void probe.catch(() => this.probes.delete(key));
    while (this.probes.size > MAX_CACHED_PROBES) {
      const oldest = this.probes.keys().next();
      if (oldest.done) break;
      this.probes.delete(oldest.value);
    }
    return probe;
  }

  /** Most recent preparations, newest first, for the /stats endpoint. */
  recentRuns(): RunSummary[] {
    return [...this.runs].reverse();
  }

  private record(summary: RunSummary): void {
    this.runs.push(summary);
    if (this.runs.length > MAX_TRACKED_RUNS) this.runs.shift();
  }
}

const TRANSLATED_PREFIX = "gemini:";

function variantId(candidate: SubtitleCandidate): string {
  return `${candidate.provider}:${candidate.providerId}`;
}

function streamFingerprint(request: SubtitleRequest, stream: StreamRecord): string {
  return request.videoHash || (request.filename ? `${request.filename}:${request.videoSize || ""}` : stableKey(stream.url));
}

function normalizedSet(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(normalizeLanguage).filter((value): value is string => Boolean(value)))];
}

function log(label: string, choice: Evaluated, probe: AudioProbeResult, startedAt: number, stages: Record<string, number>): void {
  const breakdown = Object.entries(stages).map(([stage, ms]) => `${stage}=${ms}ms`).join(" ");
  console.log([
    `${label} selected from ${choice.ranked.candidate.provider}`,
    `language=${normalizeLanguage(choice.ranked.candidate.language) || "unknown"}`,
    `confidence=${choice.confidence}`,
    `midpointOffsetMs=${choice.offsetMs}`,
    `rate=${choice.rate?.toFixed(6) || "unknown"}`,
    `audioWindows=${probe.windows.length}`,
    `elapsed=${Date.now() - startedAt}ms`,
    breakdown,
  ].join("; "));
}
