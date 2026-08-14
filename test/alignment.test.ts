import { describe, expect, it } from "vitest";
import { alignSubtitle, alignSubtitleToReference, alignSubtitleToTranscript, speechOffsetError } from "../src/alignment.js";
import type { SubtitleCue, VadWindow } from "../src/domain.js";

describe("audio alignment", () => {
  it("finds and applies a constant subtitle offset", () => {
    let cursor = 500;
    const cues: SubtitleCue[] = Array.from({ length: 40 }, (_, index) => {
      cursor += 1_900 + ((index * 1777) % 4_300);
      return {
        id: index + 1,
        startMs: cursor,
        endMs: cursor + 700 + ((index * 613) % 1_400),
        text: `Line ${index + 1}`,
      };
    });
    const trueOffset = 3_500;
    const starts = [0, 30_000, 60_000, 90_000, 120_000];
    const windows: VadWindow[] = starts.map((startMs) => ({
      startMs,
      durationMs: 24_000,
      speech: cues.flatMap((cue) => {
        const start = cue.startMs + trueOffset - startMs;
        const end = cue.endMs + trueOffset - startMs;
        return end > 0 && start < 24_000 ? [{ startMs: Math.max(0, start), endMs: Math.min(24_000, end) }] : [];
      }),
    }));
    const result = alignSubtitle(cues, windows, 10_000);
    expect(result.confidence).toBeGreaterThanOrEqual(58);
    expect(result.offsetMs).toBeCloseTo(trueOffset, -2);
    expect(result.cues[10].startMs).toBeCloseTo(cues[10].startMs + trueOffset, -2);
  });

  it("refuses unrelated activity", () => {
    const cues: SubtitleCue[] = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1, startMs: index * 5_000, endMs: index * 5_000 + 900, text: "x",
    }));
    const windows: VadWindow[] = [0, 30_000, 60_000].map((startMs) => ({
      startMs, durationMs: 20_000, speech: [{ startMs: 2_500, endMs: 2_800 }, { startMs: 14_100, endMs: 14_400 }],
    }));
    expect(alignSubtitle(cues, windows, 5_000).confidence).toBeLessThan(58);
  });

  it("corrects a common 23.976-to-25fps timing drift with one global model", () => {
    let cursor = 2_000;
    const cues: SubtitleCue[] = Array.from({ length: 260 }, (_, index) => {
      cursor += 2_100 + ((index * 977) % 3_700);
      return { id: index + 1, startMs: cursor, endMs: cursor + 850 + ((index * 313) % 900), text: `Line ${index + 1}` };
    });
    const rate = 1.042709;
    const offset = 1_500;
    const starts = [30_000, 180_000, 360_000, 540_000, 720_000, 900_000];
    const windows: VadWindow[] = starts.map((startMs) => ({
      startMs,
      durationMs: 20_000,
      speech: cues.flatMap((cue) => {
        const start = (cue.startMs * rate) + offset - startMs;
        const end = (cue.endMs * rate) + offset - startMs;
        return end > 0 && start < 20_000 ? [{ startMs: Math.max(0, start), endMs: Math.min(20_000, end) }] : [];
      }),
    }));
    const result = alignSubtitle(cues, windows, 20_000);
    expect(result.confidence).toBeGreaterThanOrEqual(58);
    expect(result.cues[180].startMs).toBeCloseTo((cues[180].startMs * rate) + offset, -2);
  });

  it("rejects a correction that would crush early cues to zero", () => {
    // The speech only matches cues from the fourth minute onward, so the sole
    // good mapping drags the opening of the subtitle behind the start of the
    // film. A subtitle that has to be mutilated to fit is not a match.
    let cursor = 5_000;
    const cues: SubtitleCue[] = Array.from({ length: 200 }, (_, index) => {
      cursor += 1_700 + ((index * 1_531) % 4_900);
      return { id: index + 1, startMs: cursor, endMs: cursor + 1_400, text: `line${index}` };
    });
    const shift = -170_000;
    const starts = [30_000, 90_000, 150_000, 210_000];
    const windows: VadWindow[] = starts.map((startMs) => ({
      startMs,
      durationMs: 15_000,
      speech: cues.flatMap((cue) => {
        const from = cue.startMs + shift - startMs;
        const to = cue.endMs + shift - startMs;
        return to > 0 && from < 15_000 ? [{ startMs: Math.max(0, from), endMs: Math.min(15_000, to) }] : [];
      }),
    }));

    const result = alignSubtitle(cues, windows, 180_000);
    expect(result.confidence).toBe(0);
    expect(result.cues[0].startMs).toBe(cues[0].startMs);
  });

  it("prefers leaving a subtitle alone over an equally plausible mangling", () => {
    // Four sampled windows cover about a minute of a two-hour film, which
    // leaves the rate badly under-determined: compressing time by four per cent
    // and shifting two minutes earlier can fit those windows as well as doing
    // nothing. Given the choice, the smaller correction is the honest one.
    let cursor = 20_000;
    const cues: SubtitleCue[] = Array.from({ length: 400 }, (_, index) => {
      cursor += 1_600 + ((index * 1_237) % 4_800);
      return { id: index + 1, startMs: cursor, endMs: cursor + 1_500, text: `line${index}` };
    });
    // Windows spread across the subtitle, covering a minute of the whole.
    const starts = [60_000, 500_000, 1_000_000, 1_500_000];
    const windows: VadWindow[] = starts.map((startMs) => ({
      startMs,
      durationMs: 15_000,
      speech: cues.flatMap((cue) => {
        const from = cue.startMs - startMs;
        const to = cue.endMs - startMs;
        return to > 0 && from < 15_000 ? [{ startMs: Math.max(0, from), endMs: Math.min(15_000, to) }] : [];
      }),
    }));

    const result = alignSubtitle(cues, windows, 180_000);
    expect(result.confidence).toBeGreaterThanOrEqual(58);
    expect(Math.abs(result.offsetMs)).toBeLessThan(1_000);
    expect(result.rate).toBeCloseTo(1, 3);
    // The whole point: no cue is dragged minutes away from where it belongs.
    expect(Math.abs(result.cues[380].startMs - cues[380].startMs)).toBeLessThan(1_000);
  });

  it("gives the same answer twice for the same title", () => {
    // The failure that prompted this: two runs of one film produced opposite
    // four per cent warps. A mapping the evidence does not pin down must not be
    // decided by whichever placement the loops happened to visit first.
    let cursor = 30_000;
    const cues: SubtitleCue[] = Array.from({ length: 500 }, (_, index) => {
      cursor += 1_500 + ((index * 977) % 5_100);
      return { id: index + 1, startMs: cursor, endMs: cursor + 1_600, text: `line${index}` };
    });
    const build = (starts: number[]): VadWindow[] => starts.map((startMs) => ({
      startMs,
      durationMs: 15_000,
      speech: cues.flatMap((cue) => {
        const from = cue.startMs + 2_000 - startMs;
        const to = cue.endMs + 2_000 - startMs;
        return to > 0 && from < 15_000 ? [{ startMs: Math.max(0, from), endMs: Math.min(15_000, to) }] : [];
      }),
    }));

    // Different sampling of the same film, as two cold runs would produce.
    const first = alignSubtitle(cues, build([80_000, 600_000, 1_100_000, 1_600_000]), 180_000);
    const second = alignSubtitle(cues, build([120_000, 640_000, 1_140_000, 1_640_000]), 180_000);
    expect(first.confidence).toBeGreaterThanOrEqual(58);
    expect(second.confidence).toBeGreaterThanOrEqual(58);
    expect(first.rate).toBeCloseTo(second.rate as number, 3);
    expect(Math.abs(first.offsetMs - second.offsetMs)).toBeLessThan(500);
  });

  it("lands on the speech even though cue spans are padded around it", () => {
    // A cue appears before its line and lingers after it, so overlap scoring is
    // flat across that padding. Without a sharper anchor the search settles
    // anywhere inside the plateau, which is what "slightly out of sync" is.
    const cues: SubtitleCue[] = Array.from({ length: 200 }, (_, index) => ({
      id: index + 1,
      startMs: 10_000 + index * 6_000,
      endMs: 10_000 + index * 6_000 + 3_800,
      text: `spoken${index} term${index % 29} line${index % 17}`,
    }));
    const trueOffset = 5_000;
    const lead = 300;
    const trail = 1_100;
    const starts = [30_000, 300_000, 600_000, 900_000];
    const windows: VadWindow[] = starts.map((startMs) => {
      const inside = cues.filter((cue) => cue.endMs + trueOffset >= startMs && cue.startMs + trueOffset <= startMs + 25_000);
      return {
        startMs,
        durationMs: 25_000,
        speech: inside.map((cue) => ({
          startMs: Math.max(0, cue.startMs + trueOffset - startMs + lead),
          endMs: Math.min(25_000, cue.endMs + trueOffset - startMs - trail),
        })).filter((interval) => interval.endMs > interval.startMs),
        transcript: inside.map((cue) => cue.text).join(" "),
        words: inside.flatMap((cue) => cue.text.split(" ").map((word, index) => ({
          word,
          startMs: cue.startMs + trueOffset - startMs + lead + index * 500,
          endMs: cue.startMs + trueOffset - startMs + lead + index * 500 + 400,
          confidence: 0.9,
        }))),
      };
    });

    const result = alignSubtitleToTranscript(cues, windows, 30_000);
    expect(result.confidence).toBeGreaterThanOrEqual(58);
    expect(Math.abs(result.offsetMs - trueOffset)).toBeLessThan(300);
  });

  it("leaves an already well-timed subtitle where it is", () => {
    // Speech beginning a moment after the cue appears is exactly the convention
    // subtitles are written to; nudging that would trade one small error for
    // another.
    const lead = 150;
    const cues: SubtitleCue[] = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      startMs: 12_000 + index * 5_000,
      endMs: 12_000 + index * 5_000 + 2_400,
      text: `unique${index} word${index % 23}`,
    }));
    const starts = [20_000, 200_000, 400_000, 590_000];
    const windows: VadWindow[] = starts.map((startMs) => {
      const inside = cues.filter((cue) => cue.endMs >= startMs && cue.startMs <= startMs + 20_000);
      return {
        startMs,
        durationMs: 20_000,
        speech: inside.map((cue) => ({
          startMs: Math.max(0, cue.startMs - startMs + lead),
          endMs: Math.min(20_000, cue.endMs - startMs),
        })).filter((interval) => interval.endMs > interval.startMs),
        transcript: inside.map((cue) => cue.text).join(" "),
      };
    });

    const result = alignSubtitleToTranscript(cues, windows, 20_000);
    expect(result.confidence).toBeGreaterThanOrEqual(58);
    expect(Math.abs(result.offsetMs)).toBeLessThanOrEqual(150);
  });

  it("uses transcribed words to identify a source-language timing track", () => {
    const cues: SubtitleCue[] = Array.from({ length: 120 }, (_, index) => ({
      id: index + 1,
      startMs: 10_000 + index * 5_000,
      endMs: 12_000 + index * 5_000,
      text: `uniqueword${index} anotherterm${index}`,
    }));
    const offset = 2_500;
    const starts = [20_000, 150_000, 300_000, 450_000];
    const windows: VadWindow[] = starts.map((startMs) => {
      const matching = cues.filter((cue) => cue.endMs + offset >= startMs && cue.startMs + offset <= startMs + 20_000);
      return {
        startMs,
        durationMs: 20_000,
        speech: matching.map((cue) => ({ startMs: Math.max(0, cue.startMs + offset - startMs), endMs: Math.min(20_000, cue.endMs + offset - startMs) })),
        transcript: matching.map((cue) => cue.text).join(" "),
      };
    });
    const result = alignSubtitleToTranscript(cues, windows, 20_000);
    expect(result.confidence).toBeGreaterThanOrEqual(58);
    expect(result.cues[40].startMs).toBeCloseTo(cues[40].startMs + offset, -3);
  });

  it("aligns a target-language track only when its events match a trusted reference", () => {
    let cursor = 8_000;
    const reference: SubtitleCue[] = Array.from({ length: 180 }, (_, index) => {
      cursor += 1_700 + ((index * 1777) % 5_300);
      return { id: index + 1, startMs: cursor, endMs: cursor + 900 + ((index * 313) % 1_100), text: `Reference ${index}` };
    });
    const offset = 3_000;
    const target = reference.map((cue) => ({ ...cue, startMs: cue.startMs - offset, endMs: cue.endMs - offset, text: `Arabic ${cue.id}` }));
    const result = alignSubtitleToReference(target, reference, 20_000);
    expect(result.confidence).toBeGreaterThanOrEqual(58);
    expect(result.cues[100].startMs).toBeCloseTo(reference[100].startMs, -2);
  });

  it("removes sub-second offset and small clock drift without a timing plateau", () => {
    let cursor = 4_000;
    const reference: SubtitleCue[] = Array.from({ length: 240 }, (_, index) => {
      cursor += 1_800 + ((index * 1237) % 4_900);
      return { id: index + 1, startMs: cursor, endMs: cursor + 1_100, text: `Reference ${index}` };
    });
    const rate = 1.0007;
    const offset = 275;
    const target = reference.map((cue) => ({
      ...cue,
      startMs: (cue.startMs - offset) / rate,
      endMs: (cue.endMs - offset) / rate,
      text: `Target ${cue.id}`,
    }));
    const result = alignSubtitleToReference(target, reference, 10_000);
    expect(result.confidence).toBeGreaterThanOrEqual(58);
    expect(Math.abs(result.cues[180].startMs - reference[180].startMs)).toBeLessThan(75);
  });

  it("measures how far a finished subtitle sits from the speech", () => {
    // The last line of defence: whatever route produced a subtitle, this asks
    // the audio directly whether it landed on the dialogue.
    const cues: SubtitleCue[] = Array.from({ length: 150 }, (_, index) => ({
      id: index + 1,
      startMs: 15_000 + index * 6_000,
      endMs: 15_000 + index * 6_000 + 2_500,
      text: `line${index}`,
    }));
    const speechFor = (displacementMs: number) => [30_000, 300_000, 600_000, 800_000].map((startMs) => ({
      startMs,
      durationMs: 20_000,
      speech: cues.flatMap((cue) => {
        const from = cue.startMs + displacementMs - startMs + 200;
        const to = cue.endMs + displacementMs - startMs;
        return to > 0 && from < 20_000 ? [{ startMs: Math.max(0, from), endMs: Math.min(20_000, to) }] : [];
      }),
    }));

    // Sitting on the speech: within the lead a subtitle is meant to have.
    expect(Math.abs(speechOffsetError(cues, speechFor(0)) as number)).toBeLessThan(200);
    // Speech arriving two seconds after the cue: the subtitle is early.
    expect(speechOffsetError(cues, speechFor(2_000)) as number).toBeGreaterThan(1_500);
    // And the other way round.
    expect(speechOffsetError(cues, speechFor(-2_000)) as number).toBeLessThan(-1_500);
    // Nothing to measure against.
    expect(speechOffsetError(cues, [])).toBeUndefined();
  });
});
