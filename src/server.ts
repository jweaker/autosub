import { timingSafeEqual } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { SubtitleCache } from "./cache.js";
import { configWarnings, loadConfig } from "./config.js";
import { HttpError } from "./http.js";
import { JobExpiredError, JobManager, JobTimeoutError } from "./jobs.js";
import { stremioLanguage } from "./languages.js";
import { AutoSubPipeline } from "./pipeline.js";
import { createProviders } from "./providers/index.js";
import { parseSubtitleRequest } from "./request.js";
import { StreamRegistry, UpstreamStreamAddon } from "./streams.js";

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true });

const providers = createProviders(config);
const registry = new StreamRegistry(join(config.dataDir, "streams.json"), config.publicUrl, config.installToken, config.streamTtlMs);
await registry.load();
const upstream = new UpstreamStreamAddon(config.upstreamAddonUrl, registry);
const cache = new SubtitleCache(config.dataDir);
const pipeline = new AutoSubPipeline(config, providers, cache);
const jobs = new JobManager(pipeline);

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

interface Bucket {
  count: number;
  reset: number;
}

const buckets = new Map<string, Bucket>();
const RATE_WINDOW_MS = 60_000;

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
  if (buckets.size > 1_000) {
    for (const [address, entry] of buckets) if (entry.reset <= now) buckets.delete(address);
  }
  next();
});

const manifest = {
  id: "community.autosub",
  version: "1.1.0",
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

app.get("/:token/manifest.json", authorized, (_request, response) => {
  response.setHeader("Cache-Control", "public, max-age=300");
  response.json(manifest);
});

app.get("/:token/stream/:type/:id.json", authorized, async (request, response, next) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
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
    for (const language of config.defaultLanguages) jobs.start(prewarm, stream, language);
    response.setHeader("Cache-Control", "no-store");
    response.redirect(302, stream.url);
  } catch (error) {
    next(error);
  }
});

async function subtitleList(request: Request, response: Response, next: NextFunction, extra?: string): Promise<void> {
  try {
    const parsed = parseSubtitleRequest(String(request.params.type), String(request.params.id), extra, config.defaultLanguages);
    const stream = await registry.waitFor(parsed);
    response.setHeader("Cache-Control", "no-store");
    if (!stream) {
      response.json({ subtitles: [] });
      return;
    }
    const subtitles = config.defaultLanguages.map((language) => {
      const jobId = jobs.start(parsed, stream, language);
      return {
        id: `autosub-${jobId}`,
        url: `${config.publicUrl}/${config.installToken}/file/${jobId}.srt`,
        lang: stremioLanguage(language),
      };
    });
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
  try {
    const result = await jobs.result(String(request.params.jobId), config.jobWaitMs);
    response.setHeader("Cache-Control", "private, max-age=86400");
    response.setHeader("X-AutoSub-Confidence", String(result.confidence));
    response.setHeader("X-AutoSub-Provider", result.provider);
    response.type("application/x-subrip; charset=utf-8").send(result.content);
  } catch (error) {
    next(error);
  }
});

/** Maps internal failures onto statuses a Stremio client can act on. */
function statusFor(error: unknown): number {
  if (error instanceof JobExpiredError) return 404;
  if (error instanceof JobTimeoutError) return 504;
  if (error instanceof HttpError) return error.status === 429 ? 429 : 502;
  if (error instanceof Error && /No subtitle|Could not determine|no audio stream|Not enough audio/i.test(error.message)) return 422;
  return 502;
}

app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  const status = statusFor(error);
  if (status >= 500) console.error(`${request.method} ${request.path}: ${message}`);
  else console.warn(`${request.method} ${request.path}: ${status} ${message}`);
  if (!response.headersSent) response.status(status).json({ error: message });
});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`AutoSub listening on port ${config.port}`);
  for (const warning of configWarnings(config)) console.warn(`WARNING: ${warning}`);
});

const maintenance = setInterval(() => {
  void registry.sweep();
  void cache.sweep(config.cacheTtlMs).then((removed) => {
    if (removed) console.log(`Removed ${removed} expired cached subtitles`);
  });
}, 60 * 60 * 1000);
maintenance.unref();
void cache.sweep(config.cacheTtlMs);

// Docker sends SIGTERM on `compose down` and on updates. Closing the listener
// lets in-flight subtitle downloads finish instead of being cut off.
let shuttingDown = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down`);
    clearInterval(maintenance);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 15_000).unref();
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason instanceof Error ? reason.message : reason);
});
