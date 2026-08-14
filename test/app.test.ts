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
import { type AutoSubPipeline, TranslationRequiredError } from "../src/pipeline.js";
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
let cache: SubtitleCache;

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

  it("lists the language entry plus a status and a retry entry", async () => {
    await start(async () => subtitle());
    await playStream();
    const subtitles = await listSubtitles();

    expect(subtitles[0].lang).toBe("ara");
    expect(subtitles[1].lang).toContain("OpenSubs");
    expect(subtitles[1].lang).toContain("81%");
    expect(subtitles.slice(2).map((entry) => entry.lang)).toEqual([
      "Arabic - Next",
      "Arabic - Next 2",
      "Arabic - Next 3",
    ]);
    // Distinct URLs, because a player will not re-request a track it already
    // loaded — one shared URL could only ever be used once per playback.
    const retryUrls = new Set(subtitles.slice(2).map((entry) => entry.url));
    expect(retryUrls.size).toBe(3);
  });

  it("walks further down the list on each retry row", async () => {
    const order = ["opensubtitles:1", "subdl:2", "subsource:3", "subdl:4"];
    const complete = vi.fn(async (_request, _stream, _language, exclude: string[] = []) => {
      const id = order[exclude.length];
      if (!id) throw new Error("No subtitle in en matched the transcribed audio");
      return subtitle({ id, provider: id.split(":")[0], confidence: 90 - exclude.length });
    });
    await start(complete as unknown as AutoSubPipeline["complete"]);
    await playStream();
    const entries = await listSubtitles();
    const retries = entries.filter((entry) => entry.url.includes("/next/"));

    const variants = [];
    for (const retry of retries) variants.push((await fetch(local(retry.url))).headers.get("x-autosub-variant"));
    expect(variants).toEqual(["subdl:2", "subsource:3", "subdl:4"]);
    // Whatever the viewer settles on is what the plain language row serves.
    expect((await fetch(local(entries[0].url))).headers.get("x-autosub-variant")).toBe("subdl:4");
  });

  it("says AI translated when the result came from the model", async () => {
    await start(async () => subtitle({ translated: true, provider: "subdl+gemini", sourceLanguage: "en", id: "gemini:subdl:7" }));
    await playStream();
    const subtitles = await listSubtitles();
    expect(subtitles[1].lang).toContain("AI English");
  });

  it("shows no status row while work is still running", async () => {
    // The player fetches this list once, so a "preparing" row written now would
    // still claim to be preparing long after the subtitle arrived.
    await start(() => new Promise<CompletedSubtitle>(() => undefined), { STATUS_PROBE_MS: "50", RETRY_ENTRIES: "1" });
    await playStream();
    const subtitles = await listSubtitles();
    expect(subtitles).toHaveLength(2);
    expect(subtitles[0].lang).toBe("ara");
    expect(subtitles[1].lang).toBe("Arabic - Next");
  });

  it("can be trimmed to a single row", async () => {
    await start(async () => subtitle(), { RETRY_ENTRIES: "0" });
    await playStream();
    const subtitles = await listSubtitles();
    expect(subtitles.filter((entry) => entry.url.includes("/next/"))).toHaveLength(0);
  });

  it("shows why nothing arrived when preparation already failed", async () => {
    await start(async () => {
      throw new Error("No subtitle in en matched the transcribed audio");
    }, { STATUS_PROBE_MS: "500" });
    await playStream();
    const subtitles = await listSubtitles();
    expect(subtitles[1].lang).toBe("No subtitle match");
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
    expect(relisted[1].lang).toContain("SubDL");
  });

  it("offers an AI translation instead of buying one unasked", async () => {
    const complete = vi.fn(async (_request, _stream, _language, _exclude: string[] = [], translate = false) => {
      if (!translate) throw new TranslationRequiredError("Arabic");
      return subtitle({ translated: true, provider: "opensubtitles+gemini", sourceLanguage: "en", id: "gemini:opensubtitles:1" });
    });
    await start(complete as unknown as AutoSubPipeline["complete"], { GEMINI_API_KEY: "k" });
    await playStream();
    const entries = await listSubtitles();

    const offer = entries.find((entry) => entry.url.includes("/translate/"));
    expect(offer?.lang).toBe("Arabic - AI (paid)");
    expect(entries[1].lang).toBe("No match - AI");

    // The plain row explains the situation rather than silently spending.
    const plain = await fetch(local(entries[0].url));
    expect(plain.headers.get("x-autosub-state")).toBe("translation-offered");
    expect(await plain.text()).toContain("Arabic - AI (paid)");
    expect(complete).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), expect.anything(), true);

    // Choosing it is what authorises the spend.
    const translated = await fetch(local(offer?.url as string));
    expect(translated.headers.get("x-autosub-translated")).toBe("true");
  });

  it("forces AI without replacing an already working normal subtitle", async () => {
    const complete = vi.fn(async (_request, _stream, _language, _exclude: string[] = [], translate = false) =>
      translate
        ? subtitle({ translated: true, provider: "opensubtitles+openai", sourceLanguage: "en", id: "translated:opensubtitles:en" })
        : subtitle());
    await start(complete as unknown as AutoSubPipeline["complete"], { GEMINI_API_KEY: "k" });
    await playStream();
    const entries = await listSubtitles();
    const normal = entries[0];
    const force = entries.find((entry) => entry.url.includes("/translate/"));

    expect((await fetch(local(normal.url))).headers.get("x-autosub-translated")).toBe("false");
    expect((await fetch(local(force?.url as string))).headers.get("x-autosub-translated")).toBe("true");
    expect(complete).toHaveBeenCalledWith(expect.anything(), expect.anything(), "ar", [], true);
    expect((await fetch(local(normal.url))).headers.get("x-autosub-translated")).toBe("false");
  });

  it("keeps selector ids stable when a failed job is recreated", async () => {
    await start(async () => {
      throw new Error("No subtitle in en matched the transcribed audio");
    }, { GEMINI_API_KEY: "k", STATUS_PROBE_MS: "100" });
    await playStream();

    const first = await listSubtitles();
    const second = await listSubtitles();
    expect(second.map((entry) => entry.id)).toEqual(first.map((entry) => entry.id));

    // The failed job itself was replaced, so its live URLs must change even
    // though Stremio's selector identities do not.
    expect(second.map((entry) => entry.url)).not.toEqual(first.map((entry) => entry.url));
    expect(first.filter((entry) => entry.lang.includes("AI (paid)"))).toHaveLength(1);
    expect(second.filter((entry) => entry.lang.includes("AI (paid)"))).toHaveLength(1);
  });

  it("hides the translation row when no model is configured", async () => {
    await start(async () => subtitle());
    await playStream();
    expect((await listSubtitles()).some((entry) => entry.url.includes("/translate/"))).toBe(false);
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

  it("keeps the menu to one entry when extras are disabled", async () => {
    await start(async () => subtitle(), { MENU_ENTRIES: "false" });
    await playStream();
    const subtitles = await listSubtitles();
    expect(subtitles).toHaveLength(1);
    expect(subtitles[0].lang).toBe("ara");
  });
});
