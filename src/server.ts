import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "./app.js";
import { SubtitleCache } from "./cache.js";
import { configWarnings, loadConfig } from "./config.js";
import { JobManager } from "./jobs.js";
import { AutoSubPipeline } from "./pipeline.js";
import { createProviders } from "./providers/index.js";
import { RejectionStore } from "./rejections.js";
import { StreamRegistry, UpstreamStreamAddon } from "./streams.js";

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const SHUTDOWN_DEADLINE_MS = 15_000;

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true });

const providers = createProviders(config);
const registry = new StreamRegistry(join(config.dataDir, "streams.json"), config.publicUrl, config.installToken, config.streamTtlMs);
await registry.load();
const upstream = new UpstreamStreamAddon(config.upstreamAddonUrl, registry);
const cache = new SubtitleCache(config.dataDir);
const rejections = new RejectionStore(config.dataDir);
await rejections.load();
const pipeline = new AutoSubPipeline(config, providers, cache);
const jobs = new JobManager(pipeline, rejections);
const app = createApp({ config, registry, upstream, jobs, providers, pipeline });

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`AutoSub listening on port ${config.port}`);
  for (const warning of configWarnings(config)) console.warn(`WARNING: ${warning}`);
});

const maintenance = setInterval(() => {
  void registry.sweep();
  void cache.sweep(config.cacheTtlMs).then((removed) => {
    if (removed) console.log(`Removed ${removed} expired cached subtitles`);
  });
}, MAINTENANCE_INTERVAL_MS);
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
    setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref();
  });
}

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason instanceof Error ? reason.message : reason);
});
