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
const CACHE_VERSION = 7;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const CANDIDATES_PER_WAVE = 3;

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

  private async evaluateCandidate(item: RankedCandidate, align: Aligner): Promise<Evaluated | undefined> {
    const provider = this.byName.get(item.candidate.provider);
    if (!provider) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const raw = await provider.download(item.candidate, controller.signal);
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
    } finally {
      clearTimeout(timer);
    }
  }

  /** Downloads and validates candidates in waves, stopping at the first confident match. */
  private async evaluate(request: SubtitleRequest, candidates: SubtitleCandidate[], align: Aligner): Promise<Evaluated | undefined> {
    const remaining = rankCandidates(request, candidates).slice(0, this.config.candidateLimit);
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

  private cacheKey(request: SubtitleRequest, stream: StreamRecord, target: string): string {
    return stableKey({
      version: CACHE_VERSION,
      type: request.type,
      id: request.contentId,
      hash: request.videoHash,
      size: request.videoSize,
      filename: request.filename,
      streamFingerprint: request.videoHash || (request.filename ? `${request.filename}:${request.videoSize || ""}` : stableKey(stream.url)),
      target,
      geminiModel: this.config.gemini.model,
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

  async complete(originalRequest: SubtitleRequest, stream: StreamRecord, targetLanguage: string): Promise<CompletedSubtitle> {
    const started = Date.now();
    const target = normalizeLanguage(targetLanguage) || targetLanguage;
    const request: SubtitleRequest = {
      ...originalRequest,
      filename: originalRequest.filename || stream.filename,
      videoHash: originalRequest.videoHash || stream.videoHash,
      videoSize: originalRequest.videoSize || stream.videoSize,
      languages: [target],
    };
    const key = this.cacheKey(request, stream, target);
    const cached = await this.cache.get(key);
    if (cached) return cached;
    if (!this.config.audioAnalysisEnabled) throw new Error("Audio analysis is disabled; refusing to guess a subtitle");

    const metadataLanguage = await this.metadata.originalLanguage(request.imdbId, request.type);
    const initialSourceLanguages = normalizedSet([metadataLanguage, ...this.config.referenceLanguages]);

    // Audio analysis and the provider searches are independent; overlapping
    // them removes several seconds from every cold start.
    const analysisPromise = this.audio.analyze(stream, metadataLanguage);
    const initialSourcePromise = this.search(request, initialSourceLanguages);
    const targetPromise = initialSourceLanguages.includes(target)
      ? initialSourcePromise
      : this.search(request, [target]);

    const probe = await analysisPromise;
    const sourceLanguages = normalizedSet([...initialSourceLanguages, probe.audioLanguage]);
    if (!sourceLanguages.length) throw new Error("Could not determine the original audio language");

    const missing = sourceLanguages.filter((language) => !initialSourceLanguages.includes(language));
    const [initialSource, additionalSource, targetCandidates] = await Promise.all([
      initialSourcePromise,
      this.search(request, missing),
      targetPromise,
    ]);

    const source = await this.evaluate(
      request,
      [...initialSource, ...additionalSource],
      (cues) => alignSubtitleToTranscript(cues, probe.windows, this.config.maxSyncOffsetSeconds * 1000),
    );
    if (!source) throw new Error(`No subtitle in ${sourceLanguages.join(", ")} matched the transcribed audio`);
    log("Trusted timing", source, probe, started);

    if (sourceLanguages.includes(target)) {
      return this.store({
        key,
        language: target,
        content: source.content,
        confidence: source.confidence,
        provider: source.ranked.candidate.provider,
        translated: false,
      });
    }

    const referenceCues = parseSrt(source.content);
    const direct = await this.evaluate(
      request,
      targetCandidates,
      (cues) => alignSubtitleToReference(cues, referenceCues, this.config.maxSyncOffsetSeconds * 1000),
    );
    if (direct) {
      log(`Direct ${target} subtitle`, direct, probe, started);
      return this.store({
        key,
        language: target,
        content: direct.content,
        confidence: Math.min(source.confidence, direct.confidence),
        provider: direct.ranked.candidate.provider,
        translated: false,
      });
    }

    const sourceLanguage = normalizeLanguage(source.ranked.candidate.language) || sourceLanguages[0];
    console.log(`No direct ${target} timing match; translating trusted ${sourceLanguage} timing with ${this.config.gemini.model}`);
    const translated = await this.translator.translate(referenceCues, sourceLanguage, target);
    return this.store({
      key,
      language: target,
      content: serializeSrt(translated),
      confidence: source.confidence,
      provider: `${source.ranked.candidate.provider}+gemini`,
      translated: true,
    });
  }
}

function normalizedSet(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(normalizeLanguage).filter((value): value is string => Boolean(value)))];
}

function log(label: string, choice: Evaluated, probe: AudioProbeResult, startedAt: number): void {
  console.log([
    `${label} selected from ${choice.ranked.candidate.provider}`,
    `language=${normalizeLanguage(choice.ranked.candidate.language) || "unknown"}`,
    `confidence=${choice.confidence}`,
    `midpointOffsetMs=${choice.offsetMs}`,
    `rate=${choice.rate?.toFixed(6) || "unknown"}`,
    `audioWindows=${probe.windows.length}`,
    `elapsed=${Date.now() - startedAt}ms`,
  ].join("; "));
}
