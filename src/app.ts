import { randomBytes, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { stableKey, type SubtitleCache } from "./cache.js";
import { translationConfigured, type AppConfig } from "./config.js";
import { renderDashboard } from "./dashboard.js";
import type { CompletedSubtitle, SubtitleProvider, SubtitleRequest } from "./domain.js";
import { PreparationError, safeError } from "./errors.js";
import { HttpError } from "./http.js";
import { JobExpiredError, type JobManager, JobTimeoutError } from "./jobs.js";
import { stremioLanguage, TARGET_LANGUAGE } from "./languages.js";
import { parseSubtitleRequest } from "./request.js";
import { parseSrt, serializeSrt } from "./srt.js";
import { bannerText, failureTrack, noticeTrack, preparingTrack, withBanner } from "./status.js";
import type { AutoSubPipeline } from "./pipeline.js";
import type { StreamRegistry, UpstreamStreamAddon } from "./streams.js";

export interface AppDependencies {
  config: AppConfig;
  registry: StreamRegistry;
  upstream: UpstreamStreamAddon;
  jobs: JobManager;
  providers: SubtitleProvider[];
  cache: Pick<SubtitleCache, "list" | "removeMany">;
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
  version: "2.0.0",
  name: "AutoSub",
  description: "Audio-validated, automatically synchronized Arabic subtitles, AI-translated when no match exists",
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
  if (error instanceof PreparationError) return ({ "no-match": 422, unavailable: 502, deadline: 504, busy: 429 })[error.code];
  if (error instanceof HttpError) return error.status === 429 ? 429 : 502;
  return 502;
}

/**
 * Builds the Stremio addon HTTP surface.
 *
 * Kept separate from process bootstrap so the routes can be exercised against
 * stub dependencies in tests, which is the only way to check what a player
 * actually receives without a TV in the loop.
 */
export function createApp({ config, registry, upstream, jobs, providers, pipeline, cache }: AppDependencies): Express {
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
  const cacheActionToken = randomBytes(24).toString("base64url");

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
      translation: translationConfigured(config)
        ? { provider: config.translation.provider, model: config.translation.model, concurrency: config.translation.concurrency }
        : "disabled",
      languageDetectionFallback: config.deepgram.apiKey ? "deepgram" : "metadata-only",
      jobs: { tracked: jobs.size, running: jobs.running, queued: jobs.queued },
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
    response.type("html").send(`<!doctype html><meta name="viewport" content="width=device-width"><title>Install AutoSub</title><style>body{font:18px system-ui;max-width:46rem;margin:8vh auto;padding:1rem;background:#101216;color:#eee}a{display:inline-block;margin:.2rem .4rem .2rem 0;padding:.8rem 1rem;background:#286f67;color:white;border-radius:.5rem;text-decoration:none}code{overflow-wrap:anywhere;color:#9ee}</style><h1>AutoSub</h1><p>Arabic is configured as the default. Keep this URL private because it grants access to your addon.</p><p><a href="${installUrl}">Install in Stremio</a><a href="${config.publicUrl}/${config.installToken}/dashboard">Open operations</a></p><p><code>${manifestUrl}</code></p>`);
  });

  // Behind the token because it names the titles that were played.
  app.get("/:token/stats", authorized, (_request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.json({ runs: pipeline.recentRuns() });
  });

  app.get("/:token/dashboard", authorized, async (request, response, next) => {
    try {
      const query = String(request.query.q || "").slice(0, 160);
      const rawCleared = Number.parseInt(String(request.query.cleared || ""), 10);
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      response.type("html").send(renderDashboard({
        config,
        runs: pipeline.recentRuns(),
        cache: await cache.list(),
        providers: providers.map((provider) => provider.name),
        jobs: { tracked: jobs.size, running: jobs.running },
        uptimeSeconds: Math.round(process.uptime()),
        basePath: `/${encodeURIComponent(config.installToken)}`,
        csrfToken: cacheActionToken,
        query,
        cleared: Number.isFinite(rawCleared) && rawCleared >= 0 ? rawCleared : undefined,
      }));
    } catch (error) {
      next(error);
    }
  });

  app.post(
    "/:token/admin/cache",
    authorized,
    express.urlencoded({ extended: false, limit: "32kb" }),
    async (request, response, next) => {
      try {
        const provided = Buffer.from(String(request.body.csrf || ""));
        const expected = Buffer.from(cacheActionToken);
        const valid = provided.length === expected.length && timingSafeEqual(provided, expected);
        if (!valid || request.body.confirm !== "yes") {
          response.status(400).type("text").send("Cache deletion confirmation is invalid. Refresh the dashboard and try again.");
          return;
        }
        const submitted: unknown[] = Array.isArray(request.body.key) ? request.body.key : [request.body.key];
        const keys = submitted.filter((key: unknown): key is string => typeof key === "string" && /^[a-f0-9]{64}$/.test(key));
        const removed = await cache.removeMany(keys);
        jobs.invalidate(keys);
        response.redirect(303, `/${encodeURIComponent(config.installToken)}/dashboard?cleared=${removed}#cache`);
      } catch (error) {
        next(error);
      }
    },
  );

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
      try {
        jobs.start(parseSubtitleRequest(stream.type, stream.contentId, undefined, [TARGET_LANGUAGE]), stream, TARGET_LANGUAGE);
      } catch (error) {
        if (!(error instanceof PreparationError) || error.code !== "busy") throw error;
        console.warn("Subtitle queue is full; playback will continue");
      }
      response.setHeader("Cache-Control", "no-store");
      response.redirect(302, stream.url);
    } catch (error) {
      next(error);
    }
  });

  const fileUrl = (path: string): string => `${config.publicUrl}/${config.installToken}/${path}`;

  /**
   * Stremio treats a changed subtitle id as another variant, so the id stays
   * stable per title while the URL follows the current (ephemeral) job.
   */
  const entryId = (request: SubtitleRequest): string =>
    `autosub-main-${stableKey({ version: 1, type: request.type, contentId: request.contentId, language: TARGET_LANGUAGE, action: "main" }).slice(0, 24)}`;

  function sendSubtitle(response: Response, result: CompletedSubtitle): void {
    const content = config.statusBanner
      ? serializeSrt(withBanner(parseSrt(result.content), bannerText(result)))
      : result.content;
    // Never cached: the same URL answers "still preparing" before it answers
    // with the finished subtitle.
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
    const language = jobs.languageOf(jobId) || TARGET_LANGUAGE;
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
    const reason = safeError(error).split(config.installToken).join("[redacted]");
    console.warn(`Subtitle request failed: ${reason}`);
    sendNotice(response, failureTrack(reason), "failed");
  }

  async function subtitleList(request: Request, response: Response, next: NextFunction, extra?: string): Promise<void> {
    try {
      const parsed = parseSubtitleRequest(String(request.params.type), String(request.params.id), extra, [TARGET_LANGUAGE]);
      const stream = await registry.waitFor(parsed, config.streamWaitMs);
      response.setHeader("Cache-Control", "no-store");
      if (!stream) {
        response.json({ subtitles: [] });
        return;
      }
      // One row with the plain ISO code, so Stremio's preferred-language
      // setting selects it automatically.
      const jobId = jobs.start(parsed, stream, TARGET_LANGUAGE);
      response.json({ subtitles: [{ id: entryId(parsed), url: fileUrl(`file/${jobId}.srt`), lang: stremioLanguage(TARGET_LANGUAGE) }] });
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

  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const message = safeError(error).split(config.installToken).join("[redacted]");
    const status = statusFor(error);
    if (status >= 500) console.error(`${request.method} ${request.route?.path || "unmatched route"}: ${message}`);
    else console.warn(`${request.method} ${request.route?.path || "unmatched route"}: ${status} ${message}`);
    if (!response.headersSent) response.status(status).json({ error: message });
  });

  return app;
}
