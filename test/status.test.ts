import { describe, expect, it } from "vitest";
import type { CompletedSubtitle, SubtitleCue } from "../src/domain.js";
import { parseSrt } from "../src/srt.js";
import { bannerText, noticeTrack, preparingTrack, withBanner } from "../src/status.js";

const result = (overrides: Partial<CompletedSubtitle> = {}): CompletedSubtitle => ({
  key: "k",
  id: "subdl:9",
  language: "ar",
  content: "",
  confidence: 74,
  provider: "subdl",
  translated: false,
  ...overrides,
});

const cue = (startMs: number): SubtitleCue => ({ id: 1, startMs, endMs: startMs + 2_000, text: "dialogue" });

describe("banner text", () => {
  it("names the provider for a found subtitle", () => {
    expect(bannerText(result())).toBe("[AutoSub] subdl subtitle - 74% match");
  });

  it("says where a translation came from", () => {
    expect(bannerText(result({ translated: true, sourceLanguage: "en" }))).toBe("[AutoSub] AI translation from English - 74% match");
  });
});

describe("banner", () => {
  it("is inserted before the first cue", () => {
    const cues = withBanner([cue(30_000)], "hello");
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe("hello");
    expect(cues[0].endMs).toBeLessThanOrEqual(cues[1].startMs);
  });

  it("is skipped when dialogue starts immediately", () => {
    // Overlapping the opening line would be worse than saying nothing.
    expect(withBanner([cue(400)], "hello")).toHaveLength(1);
  });

  it("shortens itself to fit an early first cue", () => {
    const cues = withBanner([cue(3_000)], "hello");
    expect(cues).toHaveLength(2);
    expect(cues[0].endMs).toBe(2_800);
  });

  it("still applies to an empty track", () => {
    expect(withBanner([], "hello")).toHaveLength(1);
  });
});

describe("notice tracks", () => {
  it("produces a valid, repeating subtitle", () => {
    const cues = parseSrt(noticeTrack(["first line", "second line"], 5 * 60_000));
    expect(cues.length).toBeGreaterThan(5);
    expect(cues[0].text).toBe("first line\nsecond line");
    // Repeats regularly so the viewer sees it wherever they are in the title.
    expect(cues[1].startMs - cues[0].startMs).toBe(30_000);
    expect(cues.at(-1)?.endMs).toBeLessThanOrEqual(5 * 60_000 + 5_000);
  });

  it("names the language still being prepared", () => {
    expect(preparingTrack("ar")).toContain("Still preparing the Arabic subtitle");
  });
});
