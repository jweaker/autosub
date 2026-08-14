import { mkdtemp, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stableKey, SubtitleCache } from "../src/cache.js";
import type { CompletedSubtitle } from "../src/domain.js";

const entry = (key: string): CompletedSubtitle => ({
  key,
  id: "opensubtitles:1",
  language: "ar",
  content: "1\n00:00:01,000 --> 00:00:02,000\nمرحبا\n",
  confidence: 71,
  provider: "opensubtitles",
  translated: false,
});

describe("subtitle cache", () => {
  it("round trips a stored subtitle", async () => {
    const cache = new SubtitleCache(await mkdtemp(join(tmpdir(), "autosub-cache-")));
    await cache.put(entry("abc"));
    const restored = await cache.get("abc");
    expect(restored).toMatchObject({ language: "ar", confidence: 71, provider: "opensubtitles" });
    expect(restored?.content).toContain("مرحبا");
  });

  it("returns undefined for a miss without throwing", async () => {
    const cache = new SubtitleCache(await mkdtemp(join(tmpdir(), "autosub-cache-")));
    expect(await cache.get("missing")).toBeUndefined();
  });

  it("keeps concurrent writes of the same key intact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autosub-cache-"));
    const cache = new SubtitleCache(directory);
    await Promise.all(Array.from({ length: 8 }, () => cache.put(entry("shared"))));
    expect((await cache.get("shared"))?.content).toBe(entry("shared").content);
    expect((await readdir(join(directory, "subtitles"))).filter((name) => name.includes(".tmp"))).toHaveLength(0);
  });

  it("sweeps entries older than the retention window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "autosub-cache-"));
    const cache = new SubtitleCache(directory);
    await cache.put(entry("old"));
    await cache.put(entry("new"));
    const stale = new Date(Date.now() - 10 * 86_400_000);
    await utimes(join(directory, "subtitles", "old.srt"), stale, stale);
    await utimes(join(directory, "subtitles", "old.json"), stale, stale);

    expect(await cache.sweep(86_400_000)).toBe(1);
    expect(await cache.get("old")).toBeUndefined();
    expect(await cache.get("new")).toBeDefined();
  });

  it("derives stable keys from equal inputs only", () => {
    expect(stableKey({ a: 1, b: "x" })).toBe(stableKey({ a: 1, b: "x" }));
    expect(stableKey({ a: 1 })).not.toBe(stableKey({ a: 2 }));
  });
});
