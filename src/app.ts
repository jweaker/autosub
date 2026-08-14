import { timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { AppConfig } from "./config.js";
import type { CompletedSubtitle, StreamRecord, SubtitleProvider, SubtitleRequest } from "./domain.js";
import { HttpError } from "./http.js";
import { JobExpiredError, type JobManager, JobTimeoutError } from "./jobs.js";
import { stremioLanguage } from "./languages.js";
import { parseSubtitleRequest } from "./request.js";
import { parseSrt, serializeSrt } from "./srt.js";
import {
  bannerText,
  exhaustedTrack,
  failedLabel,
  failureTrack,
  noticeTrack,
  preparingTrack,
  resultLabel,
  retryLabel,
  translateLabel,
  translationOfferTrack,
  withBanner,
} from "./status.js";
import { type AutoSubPipeline, TranslationRequiredError } from "./pipeline.js";
import type { StreamRegistry, UpstreamStreamAddon } from "./streams.js";

export interface AppDependencies {
  config: AppConfig;
  registry: StreamRegistry;
  upstream: UpstreamStreamAddon;
  jobs: JobManager;
  providers: SubtitleProvider[];
  /** Source of the recent-run summaries served by /stats. */
  pipeline: Pick<AutoSubPipeline, "recentRuns">;
}

interface Bucket {
  count: number;
  reset: number;
}

const RATE_WINDOW_MS = 60_000;
const MAX_TRACKED_CLIENTS = 1_000;
const UPSTREAM_TIMEOUT_MS = 25_000;

const manifest = {
  id: "community.autosub",
  version: "1.6.0",
  name: "AutoSub",
  description: "Audio-validated, automatically synchronized subtitles with Arabic AI fallback",
  resources: [
    { name: "stream", types: ["movie", "series"], idPrefixes: ["tt"] },
    { name: "subtitles", types: ["movie", "series"], idPrefixes: ["tt"] },
  ],
  types: ["movie", "series"],
  catalogs: [],
  idPrefixes: ["tt"],
  behaviorHints: { configurable: false },
};

/** Maps internal failures onto statuses a Stremio client can act on. */
function statusFor(error: unknown): number {
  if (error instanceof JobExpiredError) return 404;
  if (error instanceof JobTimeoutError) return 504;
  if (error instanceof HttpError) return error.status === 429 ? 429 : 502;
  if (error instanceof TranslationRequiredError) return 422;
  if (error instanceof Error && /No subtitle|Could not determine|no audio stream|Not enough audio/i.test(error.message)) return 422;
  return 502;
}

/**
 * Builds the Stremio addon HTTP surface.
 *
 * Kept separate from process bootstrap so the routes can be exercised against
 * stub dependencies in tests, which is the only way to check what a player
 * actually receives without a TV in the loop.
 */
export function createApp({ config, registry, upstream, jobs, providers, pipeline }: AppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.set("etag", false);

  app.use((_request, response, next) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  const buckets = new Map<string, Bucket>();

  app.use((request, response, next) => {
    const key = request.ip || "unknown";
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      buckets.set(key, { count: 1, reset: now + RATE_WINDOW_MS });
    } else if (++bucket.count > config.rateLimitPerMinute) {
      response.setHeader("Retry-After", String(Math.ceil((bucket.reset - now) / 1000)));
      response.status(429).json({ error: "Too many requests" });
      return;
    }
    // Expired buckets are only ever removed here, so the map cannot grow with
    // every distinct client address the tunnel forwards.
    if (buckets.size > MAX_TRACKED_CLIENTS) {
      for (const [address, entry] of buckets) if (entry.reset <= now) buckets.delete(address);
    }
    next();
  });

  const expectedToken = Buffer.from(config.installToken);

  function authorized(request: Request, response: Response, next: NextFunction): void {
    const provided = Buffer.from(String(request.params.token || ""));
    // Constant-time so the token cannot be recovered byte by byte from response
    // timing; the length check short-circuits because timingSafeEqual throws on
    // mismatched lengths.
    const valid = provided.length === expectedToken.length && timingSafeEqual(provided, expectedToken);
    if (!valid) {
      response.status(404).json({ error: "Not found" });
      return;
    }
    next();
  }

  app.get("/healthz", (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({
      ok: true,
      version: manifest.version,
      upstream: upstream.enabled,
      audioAnalysis: config.audioAnalysisEnabled,
      providers: providers.map((provider) => provider.name),
      translation: config.gemini.apiKey ? "gemini" : "disabled",
      languageDetectionFallback: config.deepgram.apiKey ? "deepgram" : "metadata-only",
      jobs: { tracked: jobs.size, running: jobs.running },
      uptimeSeconds: Math.round(process.uptime()),
    });
  });

  app.get("/", (_request, response) => {
    response.type("html").send("<!doctype html><meta name=viewport content='width=device-width'><title>AutoSub</title><style>body{font:18px system-ui;max-width:44rem;margin:10vh auto;padding:1rem;background:#101216;color:#eee}code{color:#8ee}</style><h1>AutoSub is running</h1><p>Use your private manifest URL from the server setup. This page intentionally does not reveal it.</p>");
  });

  app.get("/:token/configure", authorized, (_request, response) => {
    const manifestUrl = `${config.publicUrl}/${config.installToken}/manifest.json`;
    const installUrl = manifestUrl.replace(/^https?:\/\//, "stremio://");
    response.setHeader("Cache-Control", "no-store");
    response.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width"><title>Install AutoSub</title><style>body{font:18px system-ui;max-width:46rem;margin:8vh auto;padding:1rem;background:#101216;color:#eee}a{display:inline-block;padding:.8rem 1rem;background:#7657ff;color:white;border-radius:.5rem;text-decoration:none}code{overflow-wrap:anywhere;color:#9ee}</style><h1>AutoSub</h1><p>Arabic is configured as the default. Keep this URL private because it grants access to your addon.</p><p><a href="${installUrl}">Install in Stremio</a></p><p><code>${manifestUrl}</code></p>`);
  });

  // Behind the token because it names the titles that were played.
  app.get("/:token/stats", authorized, (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ runs: pipeline.recentRuns() });
  });

  app.get("/:token/manifest.json", authorized, (_request, response) => {
    response.setHeader("Cache-Control", "public, max-age=300");
    response.json(manifest);
  });

  app.get("/:token/stream/:type/:id.json", authorized, async (request, response, next) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const result = await upstream.streams(String(request.params.type), String(request.params.id), controller.signal);
      response.setHeader("Cache-Control", "no-store");
      response.json(result);
    } catch (error) {
      next(error);
    } finally {
      clearTimeout(timer);
    }
  });

  app.get("/:token/play/:playId", authorized, async (request, response, next) => {
    try {
      const stream = await registry.select(String(request.params.playId));
      if (!stream) {
        response.status(410).send("This stream link expired; reopen the title in Stremio");
        return;
      }
      // Start preparing before redirecting: the player will ask for the subtitle
      // list within seconds, and this is the only point where the exact release
      // is known.
      const prewarm = parseSubtitleRequest(stream.type, stream.contentId, undefined, config.defaultLanguages);
      for (const language of config.defaultLanguages) void jobs.startTracked(prewarm, stream, language);
      response.setHeader("Cache-Control", "no-store");
      response.redirect(302, stream.url);
    } catch (error) {
      next(error);
    }
  });

  interface SubtitleEntry {
    id: string;
    url: string;
    lang: string;
  }

  const fileUrl = (path: string): string => `${config.publicUrl}/${config.installToken}/${path}`;

  /**
   * Builds the menu for one language.
   *
   * The first entry keeps the plain ISO code so Stremio's "preferred subtitle
   * language" still auto-selects it. The protocol offers no field other than
   * `lang` for a row label, so anything else has to look like a language —
   * which is why there is at most one extra entry, and why it never describes
   * work in progress: the player fetches this list once, when playback starts,
   * and never again. A "preparing" label written then would still say
   * "preparing" an hour later. Progress is reported by the subtitle file
   * itself, which is generated at the moment it is requested.
   */
  async function entriesFor(request: SubtitleRequest, stream: StreamRecord, language: string): Promise<SubtitleEntry[]> {
    const jobId = await jobs.startTracked(request, stream, language);
    const entries: SubtitleEntry[] = [{
      id: `autosub-${jobId}`,
      url: fileUrl(`file/${jobId}.srt`),
      lang: stremioLanguage(language),
    }];
    if (!config.menuEntries) return entries;

    // Only state that cannot go stale earns a row: a finished result (a warm
    // or cached play) and the always-valid "try another" action.
    const snapshot = await jobs.snapshot(jobId, config.statusProbeMs);
    if (snapshot?.state === "ready") {
      entries.push({ id: `autosub-status-${jobId}`, url: fileUrl(`file/${jobId}.srt`), lang: resultLabel(snapshot.result) });
    } else if (snapshot?.state === "failed") {
      entries.push({ id: `autosub-status-${jobId}`, url: fileUrl(`file/${jobId}.srt`), lang: failedLabel() });
    }
    // One row per attempt: each has its own URL, so a viewer can reject three
    // subtitles in a row without leaving the player. Selecting any of them
    // means the same thing — "not this one, give me the next".
    for (let attempt = 1; attempt <= config.retryEntries; attempt += 1) {
      entries.push({
        id: `autosub-next-${jobId}-${attempt}`,
        url: fileUrl(`next/${jobId}/${attempt}.srt`),
        lang: retryLabel(language, attempt),
      });
    }
    // Translation costs money per title, so in manual mode it is an explicit
    // choice rather than something that happens on the viewer's behalf.
    if (config.translationMode === "manual" && config.gemini.apiKey) {
      entries.push({
        id: `autosub-translate-${jobId}`,
        url: fileUrl(`translate/${jobId}.srt`),
        lang: translateLabel(language),
      });
    }
    return entries;
  }

  function sendSubtitle(response: Response, result: CompletedSubtitle): void {
    const content = config.statusBanner
      ? serializeSrt(withBanner(parseSrt(result.content), bannerText(result)))
      : result.content;
    // Never cached: what this URL returns changes when the viewer rejects a
    // subtitle, and a stale copy would make "try another" look broken.
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-AutoSub-Confidence", String(result.confidence));
    response.setHeader("X-AutoSub-Provider", result.provider);
    response.setHeader("X-AutoSub-Translated", String(result.translated));
    response.setHeader("X-AutoSub-Variant", result.id);
    response.type("application/x-subrip; charset=utf-8").send(content);
  }

  function sendNotice(response: Response, content: string, state: string): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-AutoSub-State", state);
    response.type("application/x-subrip; charset=utf-8").send(content);
  }

  /**
   * A player shows nothing at all for a failed subtitle request, so unless the
   * operator turned it off, the reason is delivered as a readable track instead
   * of an error the viewer will never see.
   */
  function respondToFailure(response: Response, next: NextFunction, error: unknown, jobId: string): void {
    const language = jobs.languageOf(jobId) || config.defaultLanguages[0];
    if (!config.statusMessages) {
      next(error);
      return;
    }
    if (error instanceof JobTimeoutError) {
      sendNotice(response, preparingTrack(language), "preparing");
      return;
    }
    if (error instanceof JobExpiredError) {
      sendNotice(response, noticeTrack([
        "[AutoSub] This subtitle link is no longer active.",
        "Stop and reopen the title to prepare it again.",
      ]), "expired");
      return;
    }
    if (error instanceof TranslationRequiredError) {
      sendNotice(response, translationOfferTrack(language), "translation-offered");
      return;
    }
    const reason = error instanceof Error ? error.message : "Unknown error";
    console.warn(`Subtitle request failed: ${reason}`);
    sendNotice(response, failureTrack(reason), "failed");
  }

  async function subtitleList(request: Request, response: Response, next: NextFunction, extra?: string): Promise<void> {
    try {
      const parsed = parseSubtitleRequest(String(request.params.type), String(request.params.id), extra, config.defaultLanguages);
      const stream = await registry.waitFor(parsed, config.streamWaitMs);
      response.setHeader("Cache-Control", "no-store");
      if (!stream) {
        response.json({ subtitles: [] });
        return;
      }
      const subtitles = (await Promise.all(config.defaultLanguages.map((language) => entriesFor(parsed, stream, language)))).flat();
      response.json({ subtitles });
    } catch (error) {
      next(error);
    }
  }

  app.get("/:token/subtitles/:type/:id/:extra.json", authorized, (request, response, next) => {
    void subtitleList(request, response, next, String(request.params.extra));
  });
  app.get("/:token/subtitles/:type/:id.json", authorized, (request, response, next) => {
    void subtitleList(request, response, next);
  });

  app.get("/:token/file/:jobId.srt", authorized, async (request, response, next) => {
    const jobId = String(request.params.jobId);
    try {
      sendSubtitle(response, await jobs.result(jobId, config.jobWaitMs));
    } catch (error) {
      respondToFailure(response, next, error, jobId);
    }
  });

  // Selecting one of these entries says "this one is wrong": the delivered
  // subtitle is remembered as rejected and the next best candidate is prepared
  // in its place. The attempt number only makes the URL unique.
  async function serveNext(request: Request, response: Response, next: NextFunction): Promise<void> {
    const jobId = String(request.params.jobId);
    try {
      const result = await jobs.retry(jobId, config.jobWaitMs);
      if (result) {
        sendSubtitle(response, result);
        return;
      }
      if (!config.statusMessages) {
        response.status(404).json({ error: "No other subtitle passed validation" });
        return;
      }
      sendNotice(response, exhaustedTrack(jobs.languageOf(jobId) || config.defaultLanguages[0]), "exhausted");
    } catch (error) {
      respondToFailure(response, next, error, jobId);
    }
  }

  // Explicitly asking for an AI translation of the trusted timing track.
  app.get("/:token/translate/:jobId.srt", authorized, async (request, response, next) => {
    const jobId = String(request.params.jobId);
    try {
      sendSubtitle(response, await jobs.translate(jobId, config.jobWaitMs));
    } catch (error) {
      respondToFailure(response, next, error, jobId);
    }
  });

  app.get("/:token/next/:jobId.srt", authorized, (request, response, next) => {
    void serveNext(request, response, next);
  });
  app.get("/:token/next/:jobId/:attempt.srt", authorized, (request, response, next) => {
    void serveNext(request, response, next);
  });

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    const status = statusFor(error);
    if (status >= 500) console.error(`${request.method} ${request.path}: ${message}`);
    else console.warn(`${request.method} ${request.path}: ${status} ${message}`);
    if (!response.headersSent) response.status(status).json({ error: message });
  });

  return app;
}
