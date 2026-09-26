import { PreparationError } from "../src/errors.js";
import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { SubtitleCache } from "../src/cache.js";
import { loadConfig } from "../src/config.js";
import type { CompletedSubtitle, StreamRecord, SubtitleRequest } from "../src/domain.js";
import { JobManager } from "../src/jobs.js";
import type { AutoSubPipeline } from "../src/pipeline.js";
import { StreamRegistry, UpstreamStreamAddon } from "../src/streams.js";

const TOKEN = "0".repeat(64);

const srt = (text: string): string => `1\n00:00:30,000 --> 00:00:32,000\n${text}\n\n2\n00:01:00,000 --> 00:01:02,000\n${text} again\n`;

const subtitle = (overrides: Partial<CompletedSubtitle> = {}): CompletedSubtitle => ({
  key: "k",
  id: "opensubtitles:1",
  language: "ar",
  content: srt("مرحبا"),
  confidence: 81,
  provider: "opensubtitles",
  translated: false,
  ...overrides,
});

/** Stands in for the pipeline: the routes only need results, not real media. */
function stubPipeline(complete: AutoSubPipeline["complete"]): AutoSubPipeline {
  return {
    complete,
    releaseKey: (request: SubtitleRequest, _stream: StreamRecord, language: string) => `${request.type}:${request.contentId}:${language}`,
  } as AutoSubPipeline;
}

let server: Server;
let base: string;
let registry: StreamRegistry;
let jobs: JobManager;
let cache: SubtitleCache;

async function start(complete: AutoSubPipeline["complete"], environment: Record<string, string> = {}): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "autosub-app-"));
  const config = loadConfig({
    INSTALL_TOKEN: TOKEN,
    PUBLIC_URL: "https://autosub.test",
    DATA_DIR: dataDir,
    JOB_WAIT_MS: "5000",
    STREAM_WAIT_MS: "300",
    ...environment,
  });
  registry = new StreamRegistry(join(dataDir, "streams.json"), config.publicUrl, config.installToken);
  jobs = new JobManager(stubPipeline(complete));
  cache = new SubtitleCache(dataDir);
  const app = createApp({
    config,
    registry,
    upstream: new UpstreamStreamAddon(undefined, registry),
    jobs,
    providers: [],
    pipeline: { recentRuns: () => [] },
    cache,
  });
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function playStream(): Promise<void> {
  const wrapped = await registry.wrap("movie", "tt1", [{
    url: "https://debrid.test/movie.mkv",
    behaviorHints: { filename: "Movie.2024.WEB-DL.mkv" },
  }]);
  const playId = String(wrapped[0].url).split("/").at(-1) as string;
  const response = await fetch(`${base}/${TOKEN}/play/${playId}`, { redirect: "manual" });
  await response.body?.cancel();
}

const listSubtitles = async (): Promise<Array<{ id: string; url: string; lang: string }>> => {
  const response = await fetch(`${base}/${TOKEN}/subtitles/movie/tt1.json`);
  return (await response.json() as { subtitles: Array<{ id: string; url: string; lang: string }> }).subtitles;
};

/** Rewrites a public URL back onto the ephemeral test listener. */
const local = (url: string): string => url.replace("https://autosub.test", base);

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  vi.unstubAllGlobals();
});

describe("addon HTTP surface", () => {
  it("serves a manifest only to the right token", async () => {
    await start(async () => subtitle());
    expect((await fetch(`${base}/${TOKEN}/manifest.json`)).status).toBe(200);
    expect((await fetch(`${base}/wrong-token/manifest.json`)).status).toBe(404);
    // The version is in the health response so a deployment can be checked
    // without a token.
    const health = await (await fetch(`${base}/healthz`)).json() as { version: string };
    expect(health.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("lists exactly one Arabic entry", async () => {
    await start(async () => subtitle());
    await playStream();
    const subtitles = await listSubtitles();
    // The plain ISO code is what Stremio's preferred-language setting matches.
    expect(subtitles).toHaveLength(1);
    expect(subtitles[0].lang).toBe("ara");
    expect(subtitles[0].id).toMatch(/^autosub-main-/);
    expect(subtitles[0].url).toContain("/file/");
  });

  it("delivers the subtitle with a banner describing its origin", async () => {
    await start(async () => subtitle());
    await playStream();
    const [main] = await listSubtitles();
    const response = await fetch(local(main.url));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-autosub-provider")).toBe("opensubtitles");
    expect(response.headers.get("x-autosub-translated")).toBe("false");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("[AutoSub] opensubtitles subtitle - 81% match");
    expect(body).toContain("مرحبا");
    // The banner must not displace the real dialogue.
    expect(body).toContain("00:00:30,000 --> 00:00:32,000");
  });

  it("omits the banner when the operator turns it off", async () => {
    await start(async () => subtitle(), { STATUS_BANNER: "false" });
    await playStream();
    const [main] = await listSubtitles();
    expect(await (await fetch(local(main.url))).text()).not.toContain("[AutoSub]");
  });

  it("keeps the selector id stable when a failed job is recreated", async () => {
    await start(async () => {
      throw new PreparationError("no-match", "No subtitle in en matched the transcribed audio");
    });
    await playStream();

    const first = await listSubtitles();
    await fetch(local(first[0].url));
    const second = await listSubtitles();
    expect(second[0].id).toBe(first[0].id);
    // The failed job itself was replaced, so the next playback retries.
    expect(second[0].url).not.toBe(first[0].url);
  });

  it("turns a failed preparation into a readable message", async () => {
    await start(async () => {
      throw new PreparationError("no-match", "No subtitle in en matched the transcribed audio");
    });
    await playStream();
    const [main] = await listSubtitles();
    const response = await fetch(local(main.url));

    expect(response.status).toBe(200);
    expect(response.headers.get("x-autosub-state")).toBe("failed");
    const body = await response.text();
    expect(body).toContain("No subtitle passed audio validation");
    // Repeated so it is visible wherever the viewer happens to be.
    expect(body.split("-->").length).toBeGreaterThan(10);
  });

  it("returns a real error instead of a message track when notices are disabled", async () => {
    await start(async () => {
      throw new PreparationError("no-match", "No subtitle in en matched the transcribed audio");
    }, { STATUS_MESSAGES: "false" });
    await playStream();
    const [main] = await listSubtitles();
    expect((await fetch(local(main.url))).status).toBe(422);
  });

  it("tells the viewer to reopen the title when the link is stale", async () => {
    await start(async () => subtitle());
    const response = await fetch(`${base}/${TOKEN}/file/unknown-job.srt`);
    expect(response.headers.get("x-autosub-state")).toBe("expired");
    expect(await response.text()).toContain("no longer active");
  });

  it("reports recent runs behind the token", async () => {
    await start(async () => subtitle());
    expect((await fetch(`${base}/wrong/stats`)).status).toBe(404);
    const response = await fetch(`${base}/${TOKEN}/stats`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runs: [] });
  });

  it("renders an authenticated operations dashboard and removes only selected cache entries", async () => {
    await start(async () => subtitle());
    const key = "a".repeat(64);
    await cache.put(subtitle({
      key,
      contentId: "tt-dashboard",
      release: "Dashboard.Movie.2026.mkv",
      cachedAt: "2026-08-15T00:00:00.000Z",
    }));

    expect((await fetch(`${base}/wrong/dashboard`)).status).toBe(404);
    const page = await fetch(`${base}/${TOKEN}/dashboard`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(html).toContain("AutoSub operations");
    expect(html).toContain("AI translation usage");
    expect(html).toContain("Voice analysis usage");
    expect(html).toContain("Dashboard.Movie.2026.mkv");
    expect(html).not.toContain("—");
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
    expect(csrf).toBeTruthy();

    const deleted = await fetch(`${base}/${TOKEN}/admin/cache`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: csrf as string, confirm: "yes", key }),
    });
    expect(deleted.status).toBe(303);
    expect(await cache.get(key)).toBeUndefined();
  });

  it("returns an empty list when no stream has been opened", async () => {
    await start(async () => subtitle());
    const response = await fetch(`${base}/${TOKEN}/subtitles/movie/tt-unplayed.json`);
    expect(await response.json()).toEqual({ subtitles: [] });
  });

});

it("redacts private paths and media URLs from failures", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await start(async () => { throw new Error("Failed https://media.test/private-signature"); }, { STATUS_MESSAGES: "false" });
    await playStream();
    const [entry] = await listSubtitles();
    const response = await fetch(local(entry.url));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("private-signature");
    expect(log.mock.calls.flat().join(" ")).not.toContain(TOKEN);
    expect(log.mock.calls.flat().join(" ")).not.toContain("private-signature");
  } finally { log.mockRestore(); }
});
