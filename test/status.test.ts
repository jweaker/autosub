import { describe, expect, it } from "vitest";
import type { CompletedSubtitle, SubtitleCue } from "../src/domain.js";
import { parseSrt } from "../src/srt.js";
import { exhaustedTrack, failedLabel, noticeTrack, resultLabel, retryLabel, translateLabel, withBanner } from "../src/status.js";

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

describe("status labels", () => {
  it("names the provider for a found subtitle", () => {
    expect(resultLabel(result())).toBe("SubDL 74%");
  });

  it("says where a translation came from", () => {
    expect(resultLabel(result({ translated: true, sourceLanguage: "en" })))
      .toBe("AI English 74%");
  });

  it("names the language first so the row reads like the list it sits in", () => {
    expect(retryLabel("ar")).toBe("Arabic - Next");
    expect(failedLabel()).toBe("No subtitle match");
    expect(failedLabel(true)).toBe("No match - AI");
  });

  it("numbers further attempts so they read as successive tries", () => {
    expect(retryLabel("ar", 2)).toBe("Arabic - Next 2");
    expect(retryLabel("ar", 3)).toBe("Arabic - Next 3");
  });

  it("keeps menu labels short and free of symbols that TV fonts may not have", () => {
    const labels = [
      resultLabel(result()),
      resultLabel(result({ provider: "an-unusually-long-provider-name" })),
      resultLabel(result({ translated: true, sourceLanguage: "pt" })),
      failedLabel(),
      failedLabel(true),
      retryLabel("pt", 3),
      translateLabel("pt"),
    ];
    for (const label of labels) {
      expect(label).toMatch(/^[\x20-\x7E]+$/);
      expect(label.length).toBeLessThanOrEqual(18);
    }
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

  it("names the language it could not satisfy", () => {
    expect(exhaustedTrack("ar")).toContain("No other Arabic subtitle passed validation");
  });
});
