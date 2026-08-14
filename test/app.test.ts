import type { AddressInfo } from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { CompletedSubtitle, StreamRecord, SubtitleRequest } from "../src/domain.js";
import { JobManager } from "../src/jobs.js";
import type { AutoSubPipeline } from "../src/pipeline.js";
import { RejectionStore } from "../src/rejections.js";
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

async function start(complete: AutoSubPipeline["complete"], environment: Record<string, string> = {}): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "autosub-app-"));
  const config = loadConfig({
    INSTALL_TOKEN: TOKEN,
    PUBLIC_URL: "https://autosub.test",
    DATA_DIR: dataDir,
    JOB_WAIT_MS: "5000",
    STREAM_WAIT_MS: "300",
    STATUS_PROBE_MS: "1500",
    ...environment,
  });
  registry = new StreamRegistry(join(dataDir, "streams.json"), config.publicUrl, config.installToken);
  jobs = new JobManager(stubPipeline(complete), new RejectionStore(dataDir));
  const app = createApp({
    config,
    registry,
    upstream: new UpstreamStreamAddon(undefined, registry),
    jobs,
    providers: [],
    pipeline: { recentRuns: () => [] },
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
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("lists the language entry plus a status and a retry entry", async () => {
    await start(async () => subtitle());
    await playStream();
    const subtitles = await listSubtitles();

    expect(subtitles).toHaveLength(3);
    expect(subtitles[0].lang).toBe("ara");
    expect(subtitles[1].lang).toContain("found on opensubtitles");
    expect(subtitles[1].lang).toContain("81%");
    expect(subtitles[2].lang).toBe("Arabic - try another (AutoSub)");
    expect(subtitles[2].url).toContain("/next/");
  });

  it("says AI translated when the result came from the model", async () => {
    await start(async () => subtitle({ translated: true, provider: "subdl+gemini", sourceLanguage: "en", id: "gemini:subdl:7" }));
    await playStream();
    const subtitles = await listSubtitles();
    expect(subtitles[1].lang).toContain("AI translated from English");
  });

  it("shows no status row while work is still running", async () => {
    // The player fetches this list once, so a "preparing" row written now would
    // still claim to be preparing long after the subtitle arrived.
    await start(() => new Promise<CompletedSubtitle>(() => undefined), { STATUS_PROBE_MS: "50" });
    await playStream();
    const subtitles = await listSubtitles();
    expect(subtitles).toHaveLength(2);
    expect(subtitles[0].lang).toBe("ara");
    expect(subtitles[1].lang).toBe("Arabic - try another (AutoSub)");
  });

  it("shows why nothing arrived when preparation already failed", async () => {
    await start(async () => {
      throw new Error("No subtitle in en matched the transcribed audio");
    }, { STATUS_PROBE_MS: "500" });
    await playStream();
    const subtitles = await listSubtitles();
    expect(subtitles[1].lang).toBe("AutoSub: nothing matched this release");
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

  it("swaps in a different subtitle when the viewer asks for another", async () => {
    const complete = vi.fn(async (_request, _stream, _language, exclude: string[] = []) =>
      (exclude.includes("opensubtitles:1")
        ? subtitle({ id: "subdl:2", provider: "subdl", content: srt("ترجمة أخرى"), confidence: 66 })
        : subtitle()));
    await start(complete as unknown as AutoSubPipeline["complete"]);
    await playStream();
    const entries = await listSubtitles();

    const retry = await fetch(local(entries[2].url));
    const body = await retry.text();
    expect(retry.headers.get("x-autosub-variant")).toBe("subdl:2");
    expect(body).toContain("ترجمة أخرى");

    // The main entry now follows the replacement, and the rejection sticks.
    expect((await fetch(local(entries[0].url))).headers.get("x-autosub-variant")).toBe("subdl:2");
    const relisted = await listSubtitles();
    expect(relisted[1].lang).toContain("found on subdl");
  });

  it("explains when there is nothing else to try", async () => {
    const complete = vi.fn(async (_request, _stream, _language, exclude: string[] = []) => {
      if (exclude.length) throw new Error("No subtitle in en matched the transcribed audio");
      return subtitle();
    });
    await start(complete as unknown as AutoSubPipeline["complete"]);
    await playStream();
    const entries = await listSubtitles();

    const response = await fetch(local(entries[2].url));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-autosub-state")).toBe("exhausted");
    expect(await response.text()).toContain("No other Arabic subtitle passed validation");
  });

  it("turns a failed preparation into a readable message", async () => {
    await start(async () => {
      throw new Error("No subtitle in en matched the transcribed audio");
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
      throw new Error("No subtitle in en matched the transcribed audio");
    }, { STATUS_MESSAGES: "false", MENU_ENTRIES: "false" });
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

  it("returns an empty list when no stream has been opened", async () => {
    await start(async () => subtitle());
    const response = await fetch(`${base}/${TOKEN}/subtitles/movie/tt-unplayed.json`);
    expect(await response.json()).toEqual({ subtitles: [] });
  });

  it("keeps the menu to one entry when extras are disabled", async () => {
    await start(async () => subtitle(), { MENU_ENTRIES: "false" });
    await playStream();
    const subtitles = await listSubtitles();
    expect(subtitles).toHaveLength(1);
    expect(subtitles[0].lang).toBe("ara");
  });
});
