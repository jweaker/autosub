import { describe, expect, it } from "vitest";
import { energyVad, sampleSecondsFor } from "../src/audio.js";

const SAMPLE_RATE = 16_000;

/** Builds 16 kHz mono PCM where the listed ranges contain a loud tone. */
function pcm(durationMs: number, speech: Array<[number, number]>): Buffer {
  const samples = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const ms = (index / SAMPLE_RATE) * 1000;
    const loud = speech.some(([from, to]) => ms >= from && ms < to);
    const amplitude = loud ? 9_000 : 30;
    buffer.writeInt16LE(Math.round(amplitude * Math.sin(index / 7)), index * 2);
  }
  return buffer;
}

describe("energy VAD", () => {
  it("finds the spoken ranges in a quiet recording", () => {
    const intervals = energyVad(pcm(6_000, [[1_000, 2_000], [3_500, 5_000]]));
    expect(intervals.length).toBeGreaterThanOrEqual(2);
    expect(intervals[0].startMs).toBeGreaterThanOrEqual(900);
    expect(intervals[0].endMs).toBeLessThanOrEqual(2_200);
    expect(intervals.at(-1)?.endMs).toBeLessThanOrEqual(5_200);
  });

  it("reports nothing for silence", () => {
    expect(energyVad(pcm(3_000, []))).toEqual([]);
  });

  it("does not turn an isolated click into a speech run", () => {
    // Smoothing cannot erase a burst entirely, but it must stay short enough
    // that the aligner treats it as noise rather than dialogue.
    const intervals = energyVad(pcm(3_000, [[1_000, 1_030]]));
    for (const interval of intervals) expect(interval.endMs - interval.startMs).toBeLessThanOrEqual(150);
  });

  it("returns nothing for a buffer shorter than one frame", () => {
    expect(energyVad(Buffer.alloc(64))).toEqual([]);
  });
});

describe("sample length", () => {
  const budget = 240 * 1024 * 1024;
  const mbps = (rate: number): number => (rate * 1e6) / 8;

  it("keeps the configured length for an ordinary release", () => {
    // 8 Mbit 1080p: four 15s windows are only ~60 MB.
    expect(sampleSecondsFor(15, 4, budget, mbps(8))).toBe(15);
  });

  it("shortens windows to stay inside the byte budget", () => {
    // 40 Mbit: 15s windows would pull ~300 MB, so they are trimmed to fit.
    const seconds = sampleSecondsFor(15, 4, budget, mbps(40));
    expect(seconds).toBeLessThan(15);
    expect(seconds * 4 * mbps(40)).toBeLessThanOrEqual(budget);
  });

  it("never goes below the length needed to hear dialogue", () => {
    expect(sampleSecondsFor(15, 4, budget, mbps(400))).toBe(8);
  });

  it("falls back to the configured length when the bitrate is unknown", () => {
    expect(sampleSecondsFor(12, 4, budget, undefined)).toBe(12);
    expect(sampleSecondsFor(12, 4, budget, 0)).toBe(12);
  });

  it("never lengthens beyond what was asked for", () => {
    expect(sampleSecondsFor(10, 4, budget, mbps(1))).toBe(10);
  });
});
