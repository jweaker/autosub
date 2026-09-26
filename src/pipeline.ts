import { AsyncLocalStorage } from "node:async_hooks";
import { PreparationError, safeError } from "./errors.js";
import { readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { alignSubtitle, alignSubtitleToReference, alignSubtitleToTranscript, snapToSpeech, speechOffsetError } from "./alignment.js";
import { AudioAnalyzer } from "./audio.js";
import { stableKey, SubtitleCache } from "./cache.js";
import { translationConfigured, type AppConfig } from "./config.js";
import type { AlignmentResult, AudioProbeResult, CompletedSubtitle, RankedCandidate, StreamRecord, SubtitleCandidate, SubtitleCue, SubtitleProvider, SubtitleRequest } from "./domain.js";
import { languageName, normalizeLanguage } from "./languages.js";
import { MetadataService } from "./metadata.js";
import { HttpError } from "./http.js";
import { rankCandidates } from "./ranking.js";
import { parseSrt, serializeSrt, stabilizeCues } from "./srt.js";
import { prepareSubtitle } from "./subtitle-content.js";
import { createTranslator, type Translator } from "./translation/index.js";

/** Cache key version; bump when a change should invalidate stored subtitles. */
const CACHE_VERSION = 12;
const PROBE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHED_PROBES = 12;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const CANDIDATES_PER_WAVE = 3;
const MAX_SOURCE_ATTEMPTS = 5;
/**
 * How far a finished subtitle may sit from the speech before it is refused.
 *
 * Generous, because it is a last line of defence rather than a matching
 * criterion: a subtitle a second and a half from the dialogue is wrong no
 * matter which route produced it or how confident that route was.
 */
const SPEECH_ERROR_LIMIT_MS = 1_200;
const DOWNLOAD_REUSE_MS = 60_000;
const MAX_TRACKED_RUNS = 25;

export interface RunSummary {
  at: string;
  contentId: string;
  language: string;
  outcome: "cached" | "direct" | "translated" | "failed";
  /** Which evidence produced the answer: the spoken-language track, another
   * language's track, or the audio itself. */
  route?: "source" | "reference" | "audio";
  provider?: string;
  confidence?: number;
  release?: string;
  totalMs: number;
  stages: Record<string, number>;
  /** Present only for translated runs, so their cost is visible in /stats. */
  translation?: { cues: number; characters: number; promptTokens?: number; responseTokens?: number };
  /** Audio and paid speech-recognition work attributable to this run. */
  audio?: {
    windows: number;
    sampledSeconds: number;
    transcripts: number;
    deepgramRequests: number;
    deepgramSeconds: number;
    reused: boolean;
    megabitsPerSecond?: number;
  };
  /** How far the delivered subtitle sits from the speech, measured on the audio. */
  speechErrorMs?: number;
  /** Retained because the process logs may be gone when a title is investigated. */
  failure?: string;
  /** Providers whose search failed outright; a silent outage looks like "no subtitles". */
  providerErrors?: Record<string, string>;
  evaluations?: Record<string, EvaluationSummary>;
}

export interface EvaluationSummary {
  discovered: number;
  usable: number;
  attempted: number;
  decoded: number;
  passed: number;
  bestConfidence: number;
  cleanup: { removed: number; merged: number; adjusted: number };
}

interface RunContext {
  signal?: AbortSignal;
  parsed: Map<string, Promise<{ cleanup: ReturnType<typeof stabilizeCues>; contentHash: string }>>;
  aligned: WeakMap<Aligner, Map<string, Evaluated>>;
}

interface Evaluated {
  ranked: RankedCandidate;
  content: string;
  confidence: number;
  offsetMs: number;
  rate?: number;
  cleanup: { removed: number; merged: number; adjusted: number };
  contentHash: string;
  evidence: AlignmentResult["evidence"];
}

type Aligner = (cues: SubtitleCue[]) => Pick<AlignmentResult, "cues" | "confidence" | "offsetMs" | "rate" | "evidence">;

const describe = safeError;

/**
 * Turns "a user pressed play on this release" into one trusted subtitle.
 *
 * The ordering matters: audio analysis and provider searches start together,
 * the source-language track is validated against the transcript first, and the
 * target language is only accepted if it matches that trusted timing.
 */
export class AutoSubPipeline {
  private readonly context = new AsyncLocalStorage<RunContext>();
  private readonly audio: AudioAnalyzer;
  private readonly metadata: MetadataService;
  private readonly translator: Translator;
  private readonly cache: SubtitleCache;
  private readonly byName: Map<string, SubtitleProvider>;
  private readonly downloads = new Map<string, Promise<Uint8Array>>();
  private readonly providerBlockedUntil = new Map<string, number>();
  private readonly probes = new Map<string, { probe: Promise<AudioProbeResult>; at: number }>();
  private readonly runs: RunSummary[] = [];
  private readonly runsPath: string;
  private writingRuns = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly providers: SubtitleProvider[],
    cache = new SubtitleCache(config.dataDir),
  ) {
    this.audio = new AudioAnalyzer(config);
    this.metadata = new MetadataService(config.tmdbToken);
    this.translator = createTranslator(config);
    this.cache = cache;
    this.byName = new Map(providers.map((provider) => [provider.name, provider]));
    this.runsPath = join(config.dataDir, "runs.json");
    this.loadRuns();
  }

  /** Searches every provider at once; a provider that fails is logged, not fatal. */
  private async search(request: SubtitleRequest, languages: string[], failures?: Record<string, string>): Promise<SubtitleCandidate[]> {
    if (!languages.length || !this.providers.length) return [];
    const query = { ...request, languages };
    // Providers retry internally; this budget bounds the whole attempt so one
    // slow API cannot hold up the wave.
    const budgetMs = this.config.providerTimeoutMs * 3;
    const signal = this.context.getStore()?.signal;
    signal?.throwIfAborted();
    const settled = await Promise.allSettled(this.providers.map(async (provider) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budgetMs);
      try {
        return await provider.search(query, signal ? AbortSignal.any([controller.signal, signal]) : controller.signal);
      } finally {
        clearTimeout(timer);
      }
    }));

    this.context.getStore()?.signal?.throwIfAborted();
    const unique = new Map<string, SubtitleCandidate>();
    for (let index = 0; index < settled.length; index += 1) {
      const result = settled[index];
      if (result.status === "rejected") {
        console.warn(`${this.providers[index].name} search failed:`, describe(result.reason));
        if (failures) failures[this.providers[index].name] = describe(result.reason).slice(0, 160);
        continue;
      }
      for (const candidate of result.value.filter((candidate) => languages.includes(normalizeLanguage(candidate.language) || ""))) unique.set(`${candidate.provider}:${candidate.providerId}`, candidate);
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
    // Diversity chooses the first seats, but unused seats should not turn ten
    // candidates from one healthy provider into ten sequential waves.
    while (wave.length < CANDIDATES_PER_WAVE && remaining.length) {
      wave.push(remaining.shift() as RankedCandidate);
    }
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
    for (const ranked of this.nextWave(rankCandidates(request, usable).slice(0, this.config.candidateLimit))) {
      void this.download(ranked.candidate).catch(() => undefined);
    }
  }

  private download(candidate: SubtitleCandidate): Promise<Uint8Array> {
    const id = variantId(candidate);
    const pending = this.downloads.get(id);
    if (pending) return pending;
    const provider = this.byName.get(candidate.provider);
    if (!provider) return Promise.reject(new Error(`Unknown provider ${candidate.provider}`));
    const blockedUntil = this.providerBlockedUntil.get(candidate.provider) || 0;
    if (blockedUntil > Date.now()) {
      return Promise.reject(new Error(`${candidate.provider} download quota is unavailable for another ${Math.ceil((blockedUntil - Date.now()) / 60_000)} minute(s)`));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    const attempt = provider.download(candidate, controller.signal).catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 429) {
        const delay = Math.max(60_000, error.retryAfterMs || 60_000);
        this.providerBlockedUntil.set(candidate.provider, Date.now() + delay);
        console.warn(`${candidate.provider} download quota unavailable; pausing that provider for ${Math.ceil(delay / 60_000)} minute(s)`);
      }
      throw error;
    }).finally(() => {
      clearTimeout(timer);
      // Only the in-flight transfer is shared; the bytes are not kept around.
      setTimeout(() => this.downloads.delete(id), DOWNLOAD_REUSE_MS).unref?.();
    });
    this.downloads.set(id, attempt);
    return attempt;
  }

  private async evaluateCandidate(item: RankedCandidate, align: Aligner, excluded: Set<string>): Promise<Evaluated | undefined> {
    if (!this.byName.has(item.candidate.provider)) return undefined;
    try {
      const context = this.context.getStore();
      context?.signal?.throwIfAborted();
      const id = variantId(item.candidate);
      let prepared = context?.parsed.get(id);
      if (!prepared) {
        prepared = this.download(item.candidate).then((raw) => {
          context?.signal?.throwIfAborted();
          const cleanup = stabilizeCues(parseSrt(prepareSubtitle(raw, item.candidate)));
          return { cleanup, contentHash: stableKey(cleanup.cues) };
        });
        context?.parsed.set(id, prepared);
      }
      const { cleanup, contentHash } = await prepared;
      context?.signal?.throwIfAborted();
      if (excluded.has(`content:${contentHash}`)) return undefined;
      let previous = context?.aligned.get(align);
      if (!previous && context) {
        previous = new Map();
        context.aligned.set(align, previous);
      }
      const cached = previous?.get(id);
      if (cached) return cached;
      const aligned = align(cleanup.cues);
      const result: Evaluated = {
        ranked: item,
        content: serializeSrt(aligned.cues),
        confidence: aligned.confidence,
        evidence: aligned.evidence,
        offsetMs: aligned.offsetMs,
        rate: aligned.rate,
        cleanup: { removed: cleanup.removed, merged: cleanup.merged, adjusted: cleanup.adjusted },
        contentHash,
      };
      previous?.set(id, result);
      return result;
    } catch (error) {
      this.context.getStore()?.signal?.throwIfAborted();
      console.warn(`${item.candidate.provider} candidate ${item.candidate.providerId} failed:`, describe(error));
      return undefined;
    }
  }

  /**
   * Last resort before translation: find a timing reference that does not
   * depend on the spoken language.
   *
   * First another language's subtitle validated against speech activity, whose
   * events then vouch for the target across the whole title; failing that, the
   * target checked against speech activity on its own. Both are weaker evidence
   * than a transcript match, so both answer to a higher bar.
   */
  private async matchWithoutSpokenSource(
    request: SubtitleRequest,
    probe: AudioProbeResult,
    targetCandidates: SubtitleCandidate[],
    excluded: Set<string>,
    sourceLanguages: string[],
    target: string,
    mark: <T>(stage: string, work: Promise<T>) => Promise<T>,
    referenceWasTrusted: boolean,
    evaluations: Record<string, EvaluationSummary>,
    providerErrors: Record<string, string>,
  ): Promise<{ match?: { subtitle: Omit<CompletedSubtitle, "key">; evaluated: Evaluated; route: "reference" | "audio" }; reference?: Evaluated }> {
    const maxOffsetMs = this.config.maxSyncOffsetSeconds * 1000;
    const byActivity: Aligner = (cues) => alignSubtitle(cues, probe.windows, maxOffsetMs);
    const bar = this.config.activityMinimumConfidence;

    let trusted = referenceWasTrusted;
    let reference: Evaluated | undefined;
    const languages = this.config.fallbackReferenceLanguages
      .filter((language) => language !== target && !sourceLanguages.includes(language));
    if (languages.length) {
      const candidates = await mark("searchFallback", this.search(request, languages, providerErrors));
      reference = await mark("validateFallbackReference", this.evaluate(
        request, candidates, byActivity, excluded, bar, evaluation(evaluations, "fallbackReference"),
      ));
      if (reference) {
        trusted = true;
        console.log(`Using a ${normalizeLanguage(reference.ranked.candidate.language) || languages[0]} subtitle as the timing reference (confidence=${reference.confidence})`);
        const referenceCues = parseSrt(reference.content);
        const matched = await mark("validateTargetFallback", this.evaluate(
          request,
          targetCandidates,
          (cues) => alignSubtitleToReference(cues, referenceCues, maxOffsetMs),
          excluded,
          this.config.minimumConfidence,
          evaluation(evaluations, "targetFallback"),
        ));
        if (matched) {
          return {
            reference,
            match: {
              evaluated: matched,
              route: "reference",
              subtitle: {
                id: variantId(matched.ranked.candidate),
                language: target,
                content: matched.content,
                confidence: Math.min(reference.confidence, matched.confidence),
                provider: matched.ranked.candidate.provider,
                translated: false,
                contentHash: matched.contentHash,
              },
            },
          };
        }
      }
    }

    // Speech activity is the weakest evidence there is: a dense subtitle can
    // drape itself over four windows of speech blobs in many ways. When a
    // timing track was trusted and these same candidates failed against it,
    // that is a stronger answer already given, and re-asking a weaker witness
    // until one agrees is how a subtitle nobody vouched for gets served.
    if (trusted) {
      const overrideBar = Math.max(75, bar + 5);
      const corroborated = await mark("validateTargetAudioOverride", this.evaluate(
        request,
        targetCandidates,
        byActivity,
        excluded,
        overrideBar,
        evaluation(evaluations, "targetAudioOverride"),
      ));
      // A trusted reference may itself be a different edit. Audio can overrule
      // it only with near-unambiguous activity evidence and meaningful release
      // metadata; a generic or weakly named dense subtitle still cannot pass.
      if (corroborated && corroborated.ranked.score >= 35) {
        console.log(`A strongly ranked ${target} candidate overruled the rejected timing reference (audio=${corroborated.confidence}, release=${corroborated.ranked.score})`);
        return {
          reference,
          match: {
            evaluated: corroborated,
            route: "audio",
            subtitle: {
              id: variantId(corroborated.ranked.candidate),
              language: target,
              content: corroborated.content,
              confidence: Math.min(corroborated.confidence, corroborated.ranked.score + 35),
              provider: corroborated.ranked.candidate.provider,
              translated: false,
              contentHash: corroborated.contentHash,
            },
          },
        };
      }
      console.log(`Not falling back to speech activity for ${target}: a trusted timing track already rejected these candidates`);
      return { reference };
    }
    const direct = await mark("validateTargetAudio", this.evaluate(
      request, targetCandidates, byActivity, excluded, bar, evaluation(evaluations, "targetAudio"),
    ));
    if (!direct) return { reference };
    console.log(`Accepted a ${target} subtitle on speech activity alone (confidence=${direct.confidence})`);
    return {
      reference,
      match: {
        evaluated: direct,
        route: "audio",
        subtitle: {
          id: variantId(direct.ranked.candidate),
          language: target,
          content: direct.content,
          confidence: direct.confidence,
          provider: direct.ranked.candidate.provider,
          translated: false,
          contentHash: direct.contentHash,
        },
      },
    };
  }

  /** Downloads and validates candidates in waves, stopping at the first confident match. */
  private async evaluate(
    request: SubtitleRequest,
    candidates: SubtitleCandidate[],
    align: Aligner,
    excluded: Set<string>,
    minimumConfidence = this.config.minimumConfidence,
    stats?: EvaluationSummary,
  ): Promise<Evaluated | undefined> {
    const usable = candidates.filter((candidate) => !excluded.has(variantId(candidate)));
    const remaining = rankCandidates(request, usable).slice(0, this.config.candidateLimit);
    if (stats) {
      stats.discovered = Math.max(stats.discovered, candidates.length);
      stats.usable = Math.max(stats.usable, remaining.length);
    }
    const accepted: Evaluated[] = [];
    let acceptedWaves = 0;
    const strongEnoughToStop = Math.min(90, minimumConfidence + 15);
    while (remaining.length) {
      this.context.getStore()?.signal?.throwIfAborted();
      const wave = this.nextWave(remaining);
      const results = await Promise.all(wave.map((item) => this.evaluateCandidate(item, align, excluded)));
      if (stats) stats.attempted += wave.length;
      for (const result of results) {
        if (!result) continue;
        if (stats) {
          stats.decoded += 1;
          stats.bestConfidence = Math.max(stats.bestConfidence, result.confidence);
          stats.cleanup.removed += result.cleanup.removed;
          stats.cleanup.merged += result.cleanup.merged;
          stats.cleanup.adjusted += result.cleanup.adjusted;
        }
        if (result.confidence > 0 && result.confidence >= (result.evidence === "activity" ? Math.max(minimumConfidence, this.config.activityMinimumConfidence) : minimumConfidence)) {
          accepted.push(result);
          if (stats) stats.passed += 1;
        }
      }
      if (accepted.length) {
        acceptedWaves += 1;
        const best = Math.max(...accepted.map((item) => item.confidence));
        // A borderline first match is exactly where release-name ordering can
        // hand back a merely adequate file while a much better one sits in the
        // next wave. Explore one additional wave, then stop unless a clearly
        // strong match already appeared.
        if (best >= strongEnoughToStop || acceptedWaves >= 2) break;
      }
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
      streamFingerprint: streamFingerprint(request, stream),
      target,
      // A different engine produces a different translation, so cached ones
      // must not be served after the operator switches backends.
      translator: `${this.config.translation.provider}:${this.config.translation.model}`,
    });
  }

  /**
   * Fingerprint of the release itself, used to share one job between requests.
   *
   * Deliberately derived from the stream record alone. The play redirect and
   * the subtitle list describe the same release with different detail — one
   * knows the filename, the other may not — and keying on the request would
   * split them into two jobs that each run the whole pipeline.
   */
  releaseKey(request: SubtitleRequest, stream: StreamRecord, targetLanguage: string): string {
    return stableKey({
      type: request.type,
      id: request.contentId,
      streamFingerprint: stream.videoHash || (stream.filename ? `${stream.filename}:${stream.videoSize || ""}` : stableKey(stream.url)),
      target: normalizeLanguage(targetLanguage) || targetLanguage,
    });
  }

  /**
   * Final check against the audio itself, after every other decision is made.
   *
   * Each route reasons about a different kind of evidence, and each can be
   * wrong in its own way; this asks the one question none of them ask directly,
   * which is whether the finished subtitle lands on the speech.
   */
  private settleOnSpeech(content: string, probe: AudioProbeResult, label: string, report?: (error: number | undefined) => void): string | undefined {
    const cues = parseSrt(content);
    const snapped = snapToSpeech(cues, probe.windows);
    if (snapped) console.log(`Pulled ${label} ${snapped.shiftMs > 0 ? "later" : "earlier"} by ${Math.abs(snapped.shiftMs)}ms to sit on the speech`);
    const settled = stabilizeCues(snapped?.cues || cues).cues;

    const error = speechOffsetError(settled, probe.windows);
    report?.(error);
    if (error !== undefined && Math.abs(error) > SPEECH_ERROR_LIMIT_MS) {
      console.warn(`Refusing ${label}: it still sits ${error}ms from the speech in the sampled audio`);
      return undefined;
    }
    return serializeSrt(settled);
  }

  private async store(result: CompletedSubtitle, request: SubtitleRequest): Promise<CompletedSubtitle> {
    this.context.getStore()?.signal?.throwIfAborted();
    const stored = {
      ...result,
      contentId: request.contentId,
      release: request.filename,
      cachedAt: new Date().toISOString(),
    };
    try {
      await this.cache.put(stored);
    } catch (error) {
      // A cache write failure only costs time on the next play.
      console.warn("Could not cache subtitle:", describe(error));
    }
    return stored;
  }

  complete(request: SubtitleRequest, stream: StreamRecord, language: string, signal?: AbortSignal): Promise<CompletedSubtitle> {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    return this.context.run({ signal: combined, parsed: new Map(), aligned: new WeakMap() }, async () => {
      try { return await this.completeRun(request, stream, language); }
      finally {
        controller.abort();
        // Cached probe promises and download timers can retain the async context.
        const context = this.context.getStore()!;
        context.parsed.clear();
        context.aligned = new WeakMap();
      }
    });
  }

  private async completeRun(originalRequest: SubtitleRequest, stream: StreamRecord, targetLanguage: string): Promise<CompletedSubtitle> {
    const signal = this.context.getStore()?.signal;
    signal?.throwIfAborted();
    const started = Date.now();
    const target = normalizeLanguage(targetLanguage) || targetLanguage;
    const request: SubtitleRequest = {
      ...originalRequest,
      filename: originalRequest.filename || stream.filename,
      videoHash: originalRequest.videoHash || stream.videoHash,
      videoSize: originalRequest.videoSize || stream.videoSize,
      languages: [target],
    };
    const excluded = new Set<string>();
    const key = this.cacheKey(request, stream, target);
    const stages: Record<string, number> = {};
    const evaluations: Record<string, EvaluationSummary> = {};
    const providerErrors: Record<string, string> = {};
    let audioUsage: RunSummary["audio"];
    let speechError: number | undefined;
    const reportSpeechError = (error: number | undefined): void => { speechError = error; };
    const mark = <T>(stage: string, work: Promise<T>): Promise<T> => {
      const from = Date.now();
      return work.finally(() => {
        stages[stage] = Date.now() - from;
      });
    };
    let summarized = false;
    const summary = (
      outcome: RunSummary["outcome"],
      result?: CompletedSubtitle,
      translation?: RunSummary["translation"],
      route?: RunSummary["route"],
      failure?: string,
    ): void => {
      summarized = true;
      this.record({
        at: new Date().toISOString(),
        contentId: request.contentId,
        language: target,
        outcome,
        provider: result?.provider,
        confidence: result?.confidence,
        release: request.filename,
        totalMs: Date.now() - started,
        stages,
        translation,
        audio: audioUsage,
        route,
        speechErrorMs: route ? speechError : undefined,
        failure,
        providerErrors: Object.keys(providerErrors).length ? providerErrors : undefined,
        evaluations: Object.keys(evaluations).length ? evaluations : undefined,
      });
    };
    const fail = (reason: string): never => {
      summary("failed", undefined, undefined, undefined, reason);
      throw new PreparationError("no-match", reason);
    };

    try {
      const cached = await this.cache.get(key);
      if (cached) {
        summary("cached", cached);
        return cached;
      }
      if (!this.config.audioAnalysisEnabled) fail("Audio analysis is disabled; refusing to guess a subtitle");

      // Target search and media probing need no metadata; start them immediately.
      const targetPromise = mark("searchTarget", this.search(request, [target], providerErrors));
      const metadataPromise = mark("metadata", this.metadata.originalLanguage(request.imdbId, request.type, signal));
      const analysis = this.analyze(stream, metadataPromise);
      const analysisPromise = mark("audio", analysis.probe);
      // Attach handlers immediately while metadata is still pending.
      void targetPromise.catch(() => undefined);
      void analysisPromise.catch(() => undefined);
      const metadataLanguage = await metadataPromise;
      signal?.throwIfAborted();
      const initialSourceLanguages = normalizedSet([metadataLanguage, ...this.config.referenceLanguages]);
      const initialSourcePromise = mark("search", this.search(request, initialSourceLanguages.filter((language) => language !== target), providerErrors));
      void initialSourcePromise.catch(() => undefined);

      const probe = await analysisPromise;
      audioUsage = {
        windows: probe.windows.length,
        sampledSeconds: Number(probe.windows.reduce((total, window) => total + window.durationMs, 0).toFixed(0)) / 1000,
        transcripts: probe.windows.filter((window) => Boolean(window.transcript)).length,
        deepgramRequests: analysis.reused ? 0 : (probe.deepgramRequests || 0),
        deepgramSeconds: analysis.reused ? 0 : (probe.deepgramSeconds || 0),
        reused: analysis.reused,
        megabitsPerSecond: probe.megabitsPerSecond,
      };
      const sourceLanguages = normalizedSet([...initialSourceLanguages, probe.audioLanguage]);
      if (!sourceLanguages.length) fail("Could not determine the original audio language");

      const missing = sourceLanguages.filter((language) => language !== target && !initialSourceLanguages.includes(language));
      const [initialSource, additionalSource, targetCandidates] = await Promise.all([
        initialSourcePromise,
        this.search(request, missing, providerErrors),
        targetPromise,
      ]);
      const sourceCandidates = [...initialSource, ...additionalSource, ...(sourceLanguages.includes(target) ? targetCandidates : [])];

      // The target files are needed next in almost every run; fetching them now
      // overlaps their transfer with validating the source track.
      if (!sourceLanguages.includes(target)) this.prefetch(request, targetCandidates, excluded);

      // A source track can match the audio and still be useless as a timing
      // reference — it may be cut for a different edit, or padded with stray cues
      // that put its events nowhere near the target's. So a source that no target
      // can align to is discarded and the next best one tried, rather than
      // treating one bad reference as proof that no target subtitle fits.
      const rejectedSources = new Set(excluded);
      // The best transcript-validated track is kept as the translation source
      // should no target subtitle fit any of them.
      let bestSource: Evaluated | undefined;
      const alignSource: Aligner = (cues) => alignSubtitleToTranscript(cues, probe.windows, this.config.maxSyncOffsetSeconds * 1000);
      for (let attempt = 0; attempt < MAX_SOURCE_ATTEMPTS; attempt += 1) {
        const source = await mark(`validateSource${attempt || ""}`, this.evaluate(
          request,
          sourceCandidates,
          alignSource,
          rejectedSources,
          this.config.minimumConfidence,
          evaluation(evaluations, "source"),
        ));
        if (!source) break;
        bestSource ??= source;
        log("Trusted timing", source, probe, started, stages);

        const settledSource = normalizeLanguage(source.ranked.candidate.language) === target
          ? this.settleOnSpeech(source.content, probe, variantId(source.ranked.candidate), reportSpeechError)
          : undefined;
        if (settledSource) {
          const result = await this.store({
            key,
            id: variantId(source.ranked.candidate),
            language: target,
            content: settledSource,
            confidence: source.confidence,
            provider: source.ranked.candidate.provider,
            translated: false,
            contentHash: source.contentHash,
          }, request);
          summary("direct", result, undefined, "source");
          return result;
        }

        const referenceCues = parseSrt(source.content);
        const direct = await mark(`validateTarget${attempt || ""}`, this.evaluate(
          request,
          targetCandidates,
          (cues) => alignSubtitleToReference(cues, referenceCues, this.config.maxSyncOffsetSeconds * 1000),
          excluded,
          this.config.minimumConfidence,
          evaluation(evaluations, "target"),
        ));
        const settledDirect = direct ? this.settleOnSpeech(direct.content, probe, variantId(direct.ranked.candidate), reportSpeechError) : undefined;
        if (direct && settledDirect) {
          log(`Direct ${target} subtitle`, direct, probe, started, stages);
          const result = await this.store({
            key,
            id: variantId(direct.ranked.candidate),
            language: target,
            content: settledDirect,
            confidence: Math.min(source.confidence, direct.confidence),
            provider: direct.ranked.candidate.provider,
            translated: false,
            contentHash: direct.contentHash,
          }, request);
          summary("direct", result, undefined, "source");
          return result;
        }

        console.warn(`No ${target} subtitle matched the ${source.ranked.candidate.provider}:${source.ranked.candidate.providerId} timing track; trying another source`);
        rejectedSources.add(variantId(source.ranked.candidate));
        rejectedSources.add(`content:${source.contentHash}`);
      }

      // Nothing in the spoken language could carry the timing. The audio itself
      // is language-independent evidence, so a subtitle in another language can
      // be checked against speech activity and then vouch for the target — which
      // is what matters for a film whose original language has a handful of
      // subtitles but whose English catalogue has hundreds.
      const fallback = await this.matchWithoutSpokenSource(
        request, probe, targetCandidates, excluded, sourceLanguages, target, mark,
        Boolean(bestSource), evaluations, providerErrors,
      );
      const settledFallback = fallback.match ? this.settleOnSpeech(fallback.match.subtitle.content, probe, fallback.match.subtitle.id, reportSpeechError) : undefined;
      if (fallback.match && settledFallback) {
        const result = await this.store({ key, ...fallback.match.subtitle, content: settledFallback }, request);
        log(`Fallback ${target} subtitle`, fallback.match.evaluated, probe, started, stages);
        summary("direct", result, undefined, fallback.match.route);
        return result;
      }

      // No existing target subtitle fits, so one is generated. A track checked
      // against the words actually spoken is the better timing source; a
      // track checked against speech activity is the next best, and for films
      // whose original language has no subtitles at all it is the only one.
      const source = bestSource || fallback.reference;
      if (!source) {
        const tried = [...new Set([...sourceLanguages, ...this.config.fallbackReferenceLanguages])].filter((language) => language !== target);
        fail(`No subtitle in ${tried.join(", ")} matched the audio of this release`);
      }
      if (!translationConfigured(this.config)) fail(`No ${languageName(target)} subtitle matched and AI translation is not configured`);
      const translationSource = source as Evaluated;
      const route = bestSource ? "source" : "reference";
      const sourceLanguage = normalizeLanguage(translationSource.ranked.candidate.language) || sourceLanguages[0];
      if (sourceLanguage === target) fail(`Cannot AI translate ${languageName(sourceLanguage)} into the same language`);

      const referenceCues = parseSrt(translationSource.content);
      console.log(`No ${target} timing match; translating trusted ${sourceLanguage} timing with ${this.translator.name} (${this.config.translation.model})`);
      const translated = await mark("translate", this.translator.translate(referenceCues, sourceLanguage, target, signal));
      // A translation carries the timing of the track it was translated from, so
      // it answers to the audio like everything else.
      const settledTranslation = this.settleOnSpeech(serializeSrt(translated), probe, "the translation", reportSpeechError);
      if (!settledTranslation) fail(`The ${sourceLanguage} timing track does not match the audio closely enough to translate from`);
      const result = await this.store({
        key,
        id: `${TRANSLATED_PREFIX}${variantId(translationSource.ranked.candidate)}`,
        language: target,
        content: settledTranslation as string,
        confidence: translationSource.confidence,
        provider: `${translationSource.ranked.candidate.provider}+${this.translator.name}`,
        translated: true,
        sourceLanguage,
        contentHash: stableKey(settledTranslation),
        sourceContentHash: translationSource.contentHash,
      }, request);
      const usage = this.translator.usageFor?.(translated) || this.translator.lastUsage;
      summary("translated", result, {
        cues: referenceCues.length,
        characters: usage?.characters ?? 0,
        promptTokens: usage?.promptTokens,
        responseTokens: usage?.responseTokens,
      }, route);
      console.log(`Translated ${referenceCues.length} cues to ${target} with ${this.translator.name}; characters=${usage?.characters ?? "?"} tokensIn=${usage?.promptTokens ?? "-"} tokensOut=${usage?.responseTokens ?? "-"}`);
      return result;
    } catch (error) {
      if (!summarized) summary("failed", undefined, undefined, undefined, describe(error));
      throw error;
    }
  }

  /**
   * Audio analysis is by far the slowest step, and a failed run retried on the
   * next play asks the same questions of the same audio, so a probe is kept in
   * memory for the release.
   * Reusing the object also reuses the aligner's per-window precomputation.
   */
  private analyze(stream: StreamRecord, metadataLanguage: Promise<string | undefined>): { probe: Promise<AudioProbeResult>; reused: boolean } {
    const key = stream.videoHash || stream.url;
    const cached = this.probes.get(key);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) return { probe: cached.probe, reused: true };
    // The promise is cached, not the result, so two languages starting together
    // share one ffmpeg pass instead of racing to make the same one.
    const probe = this.audio.analyze(stream, metadataLanguage, this.context.getStore()?.signal);
    this.probes.set(key, { probe, at: Date.now() });
    void probe.catch(() => { if (this.probes.get(key)?.probe === probe) this.probes.delete(key); });
    while (this.probes.size > MAX_CACHED_PROBES) {
      const oldest = this.probes.keys().next();
      if (oldest.done) break;
      this.probes.delete(oldest.value);
    }
    return { probe, reused: false };
  }

  /** Most recent preparations, newest first, for the /stats endpoint. */
  recentRuns(): RunSummary[] {
    return [...this.runs].reverse();
  }

  private record(summary: RunSummary): void {
    this.runs.push(summary);
    if (this.runs.length > MAX_TRACKED_RUNS) this.runs.shift();
    // Kept on disk because the runs worth explaining are usually the ones
    // followed by a restart.
    this.writingRuns = this.writingRuns
      .then(async () => {
        const temporary = `${this.runsPath}.${process.pid}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(this.runs), { encoding: "utf8", mode: 0o600 });
          await rename(temporary, this.runsPath);
        } finally { await rm(temporary, { force: true }); }
      })
      .catch((error: unknown) => console.warn("Could not persist run history:", safeError(error)));
  }

  private loadRuns(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.runsPath, "utf8")) as RunSummary[];
      if (Array.isArray(parsed)) this.runs.push(...parsed.slice(-MAX_TRACKED_RUNS));
    } catch {
      // No history yet, or it is unreadable; either way start fresh.
    }
  }
}

const TRANSLATED_PREFIX = "translated:";

function variantId(candidate: SubtitleCandidate): string {
  return `${candidate.provider}:${candidate.providerId}`;
}

function streamFingerprint(request: SubtitleRequest, stream: StreamRecord): string {
  return request.videoHash || (request.filename ? `${request.filename}:${request.videoSize || ""}` : stableKey(stream.url));
}

function normalizedSet(values: Array<string | undefined>): string[] {
  return [...new Set(values.map(normalizeLanguage).filter((value): value is string => Boolean(value)))];
}

function evaluation(all: Record<string, EvaluationSummary>, name: string): EvaluationSummary {
  return (all[name] ??= {
    discovered: 0,
    usable: 0,
    attempted: 0,
    decoded: 0,
    passed: 0,
    bestConfidence: 0,
    cleanup: { removed: 0, merged: 0, adjusted: 0 },
  });
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
