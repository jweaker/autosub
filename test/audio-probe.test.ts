import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamRecord } from "../src/domain.js";

// Only ffprobe's answer matters here; sampling must never be reached.
const probe = vi.hoisted(() => ({ output: {} as unknown, calls: [] as string[] }));
vi.mock("../src/process.js", () => ({
  runProcess: async (command: string) => {
    probe.calls.push(command);
    if (command !== "ffprobe") throw new Error("sampling must not start");
    return { stdout: Buffer.from(JSON.stringify(probe.output)), stderr: "" };
  },
}));

const { AudioAnalyzer } = await import("../src/audio.js");
const { loadConfig } = await import("../src/config.js");

const stream: StreamRecord = { playId: "p", type: "movie", contentId: "tt1", url: "https://debrid.test/a.mkv", discoveredAt: Date.now() };
const audio = { index: 1, codec_type: "audio", tags: { language: "jpn" } };

afterEach(() => {
  vi.unstubAllGlobals();
  probe.calls = [];
});

describe("audio probe", () => {
  it("names a debrid placeholder clip instead of blaming the audio", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    probe.output = { format: { duration: "30.000000", bit_rate: "39722" }, streams: [audio] };
    await expect(new AudioAnalyzer(loadConfig({})).analyze(stream)).rejects.toThrow(/placeholder video/);
    expect(probe.calls).toEqual(["ffprobe"]);
  });

  it("refuses a release too heavy to sample before downloading any of it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    probe.output = { format: { duration: "7200", bit_rate: String(1_500_000_000) }, streams: [audio] };
    await expect(new AudioAnalyzer(loadConfig({})).analyze(stream)).rejects.toThrow(/1500 Mbps, too heavy/);
    expect(probe.calls).toEqual(["ffprobe"]);
  });
});

it("does not seek replacement audio when activity-only samples already contain speech", async () => {
  const analyser = new AudioAnalyzer(loadConfig({}));
  const internals = analyser as unknown as {
    resolveMediaUrl: () => Promise<string>;
    probe: () => Promise<unknown>;
    analyser: () => (startMs: number) => Promise<unknown>;
  };
  internals.resolveMediaUrl = async () => stream.url;
  internals.probe = async () => ({ durationMs: 7200000, durationKnown: true, streams: [audio], bytesPerSecond: 1_000_000 });
  const sample = vi.fn(async (startMs: number) => ({
    pcm: Buffer.alloc(0),
    window: { startMs, durationMs: 15000, speech: [{ startMs: 1000, endMs: 5000 }] },
  }));
  internals.analyser = () => sample;
  expect((await analyser.analyze(stream)).windows).toHaveLength(4);
  expect(sample).toHaveBeenCalledTimes(4);
});

it("starts another sample while an earlier worker is still busy", async () => {
  const analyser = new AudioAnalyzer(loadConfig({ AUDIO_CONCURRENCY: "2" }));
  const collect = (analyser as unknown as { collect: (starts: number[], work: (start: number) => Promise<undefined>) => Promise<unknown> }).collect.bind(analyser);
  let finish!: () => void;
  const slow = new Promise<void>((resolve) => { finish = resolve; });
  const started: number[] = [];
  const pending = collect([1, 2, 3], async (start) => {
    started.push(start);
    if (start === 1) await slow;
    return undefined;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(started).toEqual([1, 2, 3]);
  finish();
  await pending;
});
