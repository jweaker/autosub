import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SubtitleRequest } from "../src/domain.js";
import { StreamRegistry, UpstreamStreamAddon } from "../src/streams.js";

const temporaryPath = async (): Promise<string> => join(await mkdtemp(join(tmpdir(), "autosub-")), "streams.json");
const movie = (overrides: Partial<SubtitleRequest> = {}): SubtitleRequest => ({
  type: "movie",
  contentId: "tt123",
  languages: ["ar"],
  ...overrides,
});

describe("stream registry", () => {
  it("wraps, selects, and durably remembers a direct stream", async () => {
    const path = await temporaryPath();
    const registry = new StreamRegistry(path, "https://sub.example", "secret");
    const wrapped = await registry.wrap("movie", "tt123", [{
      url: "https://real-debrid.example/file.mkv",
      behaviorHints: { filename: "Movie.2026.WEB-DL.mkv", videoHash: "hash" },
    }]);
    const playId = String(wrapped[0].url).split("/").at(-1) as string;
    expect(String(wrapped[0].url)).toBe(`https://sub.example/secret/play/${playId}`);
    expect((await registry.select(playId))?.url).toBe("https://real-debrid.example/file.mkv");

    const restored = new StreamRegistry(path, "https://sub.example", "secret");
    expect((await restored.find(movie()))?.filename).toContain("WEB-DL");
    expect(JSON.parse(await readFile(path, "utf8")).records).toHaveLength(1);
  });

  it("does not pass torrent-only results to the client", async () => {
    const registry = new StreamRegistry(await temporaryPath(), "https://sub.example", "secret");
    expect(await registry.wrap("movie", "tt123", [{ infoHash: "deadbeef", fileIdx: 1 }])).toEqual([]);
  });

  it("reuses the play link when the same title is listed again", async () => {
    const path = await temporaryPath();
    const registry = new StreamRegistry(path, "https://sub.example", "secret");
    const stream = { url: "https://real-debrid.example/file.mkv", behaviorHints: { filename: "Movie.mkv" } };
    const first = await registry.wrap("movie", "tt123", [stream]);
    const second = await registry.wrap("movie", "tt123", [stream]);
    expect(second[0].url).toBe(first[0].url);
    // Re-listing a title must not append a new record on every refresh.
    expect(JSON.parse(await readFile(path, "utf8")).records).toHaveLength(1);
  });

  it("matches a subtitle request by hash, filename, then size", async () => {
    const registry = new StreamRegistry(await temporaryPath(), "https://sub.example", "secret");
    await registry.wrap("movie", "tt123", [
      { url: "https://d.example/a.mkv", behaviorHints: { filename: "A.mkv", videoHash: "aaa", videoSize: 10 } },
      { url: "https://d.example/b.mkv", behaviorHints: { filename: "B.mkv", videoHash: "bbb", videoSize: 20 } },
    ]);
    expect((await registry.find(movie({ videoHash: "bbb" })))?.filename).toBe("B.mkv");
    expect((await registry.find(movie({ filename: "A.mkv" })))?.filename).toBe("A.mkv");
    expect((await registry.find(movie({ videoSize: 20 })))?.filename).toBe("B.mkv");
    // Ambiguous requests must not guess between releases.
    expect(await registry.find(movie())).toBeUndefined();
  });

  it("prefers the release the user actually opened", async () => {
    const registry = new StreamRegistry(await temporaryPath(), "https://sub.example", "secret");
    const wrapped = await registry.wrap("movie", "tt123", [
      { url: "https://d.example/a.mkv", behaviorHints: { filename: "A.mkv" } },
      { url: "https://d.example/b.mkv", behaviorHints: { filename: "B.mkv" } },
    ]);
    await registry.select(String(wrapped[1].url).split("/").at(-1) as string);
    expect((await registry.find(movie()))?.filename).toBe("B.mkv");
  });

  it("forgets records once their lifetime passes", async () => {
    const registry = new StreamRegistry(await temporaryPath(), "https://sub.example", "secret", 20);
    const wrapped = await registry.wrap("movie", "tt123", [{ url: "https://d.example/a.mkv" }]);
    const playId = String(wrapped[0].url).split("/").at(-1) as string;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await registry.select(playId)).toBeUndefined();
    expect(await registry.find(movie())).toBeUndefined();
  });

  it("resolves a waiting subtitle request as soon as the stream is opened", async () => {
    const registry = new StreamRegistry(await temporaryPath(), "https://sub.example", "secret");
    const wrapped = await registry.wrap("movie", "tt999", [
      { url: "https://d.example/a.mkv", behaviorHints: { filename: "A.mkv" } },
      { url: "https://d.example/b.mkv", behaviorHints: { filename: "B.mkv" } },
    ]);
    const started = Date.now();
    const pending = registry.waitFor(movie({ contentId: "tt999" }), 5_000);
    setTimeout(() => void registry.select(String(wrapped[0].url).split("/").at(-1) as string), 50);
    const record = await pending;
    expect(record?.filename).toBe("A.mkv");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("gives up waiting when no stream is ever opened", async () => {
    const registry = new StreamRegistry(await temporaryPath(), "https://sub.example", "secret");
    expect(await registry.waitFor(movie({ contentId: "tt404" }), 100)).toBeUndefined();
  });
});

describe("upstream addon", () => {
  it("is disabled without a manifest URL", async () => {
    const registry = new StreamRegistry(await temporaryPath(), "https://sub.example", "secret");
    const upstream = new UpstreamStreamAddon(undefined, registry);
    expect(upstream.enabled).toBe(false);
    expect(await upstream.streams("movie", "tt1", new AbortController().signal)).toEqual({ streams: [] });
  });
});
