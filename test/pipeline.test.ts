import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioProbeResult, StreamRecord, SubtitleCandidate, SubtitleCue, SubtitleProvider, SubtitleRequest, VadWindow } from "../src/domain.js";

// The analyzer shells out to ffmpeg and Deepgram, so the pipeline is exercised
// against a recorded-looking probe instead of real media.
const probe = vi.hoisted(() => ({ current: undefined as AudioProbeResult | undefined }));
const analyses = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/audio.js", () => ({
  AudioAnalyzer: class {
    async analyze(): Promise<AudioProbeResult> {
      if (!probe.current) throw new Error("no probe configured");
      analyses.count += 1;
      return probe.current;
    }
  },
}));

const { AutoSubPipeline } = await import("../src/pipeline.js");
const { loadConfig } = await import("../src/config.js");
const { serializeSrt } = await import("../src/srt.js");

function makeCues(count: number, offsetMs = 0, label = "line"): SubtitleCue[] {
  let cursor = 6_000;
  return Array.from({ length: count }, (_, index) => {
    cursor += 1_500 + ((index * 2_311) % 7_000);
    return {
      id: index + 1,
      startMs: cursor + offsetMs,
      endMs: cursor + offsetMs + 1_400,
      text: `${label}${index} token${index % 37} word${index % 19}`,
    };
  });
}

function makeProbe(cues: SubtitleCue[], shiftMs: number, language: string): AudioProbeResult {
  const starts = [20_000, 220_000, 460_000, 700_000];
  const windows: VadWindow[] = starts.map((startMs) => {
    const inside = cues.filter((cue) => cue.endMs + shiftMs >= startMs && cue.startMs + shiftMs <= startMs + 25_000);
    return {
      startMs,
      durationMs: 25_000,
      speech: inside.map((cue) => ({
        startMs: Math.max(0, cue.startMs + shiftMs - startMs),
        endMs: Math.min(25_000, cue.endMs + shiftMs - startMs),
      })),
      transcript: inside.map((cue) => cue.text).join(" "),
    };
  });
  return { durationMs: 900_000, audioLanguage: language, audioStreamIndex: 1, windows };
}

class FakeProvider implements SubtitleProvider {
  readonly enabled = true;
  searches = 0;
  downloads = 0;

  constructor(readonly name: string, private readonly files: Map<string, { language: string; content: string }>) {}

  async search(request: SubtitleRequest): Promise<SubtitleCandidate[]> {
    this.searches += 1;
    return [...this.files]
      .filter(([, file]) => request.languages.includes(file.language))
      .map(([id, file]) => ({
        provider: this.name,
        providerId: id,
        language: file.language,
        filename: `${id}.srt`,
        locator: { id },
      }));
  }

  async download(candidate: SubtitleCandidate): Promise<Uint8Array> {
    this.downloads += 1;
    const file = this.files.get(String(candidate.locator.id));
    if (!file) throw new Error("unknown candidate");
    return new Uint8Array(Buffer.from(file.content, "utf8"));
  }
}

const stream: StreamRecord = {
  playId: "play",
  type: "movie",
  contentId: "tt1",
  url: "https://debrid.example/movie.mkv",
  filename: "Movie.2024.1080p.WEB-DL-GROUP.mkv",
  discoveredAt: Date.now(),
};

const request: SubtitleRequest = { type: "movie", contentId: "tt1", imdbId: "tt1", languages: ["ar"] };

const sourceCues = makeCues(90, 0, "spoken");
const shiftMs = 4_000;

async function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    INSTALL_TOKEN: "0".repeat(64),
    PUBLIC_URL: "https://autosub.test",
    DATA_DIR: await mkdtemp(join(tmpdir(), "autosub-pipeline-")),
    REFERENCE_LANGUAGES: "en",
    MINIMUM_CONFIDENCE: "40",
    ...overrides,
  });
}

beforeEach(() => {
  probe.current = makeProbe(sourceCues, shiftMs, "en");
  analyses.count = 0;
});

afterEach(() => vi.unstubAllGlobals());

describe("subtitle pipeline", () => {
  it("accepts a target subtitle that matches the trusted source timing", async () => {
    // The Arabic track is offset differently; alignment has to reconcile it.
    const arabic = sourceCues.map((cue) => ({ ...cue, startMs: cue.startMs - 2_500, endMs: cue.endMs - 2_500, text: `عربي ${cue.id}` }));
    const provider = new FakeProvider("fake", new Map([
      ["en-1", { language: "en", content: serializeSrt(sourceCues) }],
      ["ar-1", { language: "ar", content: serializeSrt(arabic) }],
    ]));
    const pipeline = new AutoSubPipeline(await config(), [provider]);

    const result = await pipeline.complete(request, stream, "ar");
    expect(result.translated).toBe(false);
    expect(result.provider).toBe("fake");
    expect(result.content).toContain("عربي");
    expect(result.confidence).toBeGreaterThanOrEqual(40);
  });

  it("serves the second play from cache without touching providers", async () => {
    const provider = new FakeProvider("fake", new Map([
      ["en-1", { language: "en", content: serializeSrt(sourceCues) }],
      ["ar-1", { language: "ar", content: serializeSrt(sourceCues.map((cue) => ({ ...cue, text: `عربي ${cue.id}` }))) }],
    ]));
    const settings = await config();
    const pipeline = new AutoSubPipeline(settings, [provider]);

    await pipeline.complete(request, stream, "ar");
    const searches = provider.searches;
    const again = await new AutoSubPipeline(settings, [provider]).complete(request, stream, "ar");
    expect(provider.searches).toBe(searches);
    expect(again.language).toBe("ar");
  });

  it("translates the trusted source when no target subtitle matches", async () => {
    const provider = new FakeProvider("fake", new Map([["en-1", { language: "en", content: serializeSrt(sourceCues) }]]));
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
      const cues = JSON.parse(body.contents[0].parts[0].text.split("Cues: ")[1]) as Array<{ id: number }>;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(cues.map((cue) => ({ id: cue.id, text: `مترجم ${cue.id}` }))) }] } }],
      }), { status: 200 });
    }));

    const result = await new AutoSubPipeline(await config({ GEMINI_API_KEY: "test-key" }), [provider]).complete(request, stream, "ar");
    expect(result.translated).toBe(true);
    expect(result.provider).toBe("fake+gemini");
    expect(result.content).toContain("مترجم");
    // Timing comes from the validated source, never from the model.
    expect(result.content).toContain("-->");
  });

  it("refuses to guess when nothing matches the audio", async () => {
    // Different dialogue at different times: no offset or rate can reconcile it.
    const unrelated = makeCues(90, 400_000, "unrelated")
      .map((cue, index) => ({ ...cue, text: `foreign${index} alpha${index} beta${index}` }));
    const provider = new FakeProvider("fake", new Map([["en-1", { language: "en", content: serializeSrt(unrelated) }]]));
    await expect(new AutoSubPipeline(await config({ MINIMUM_CONFIDENCE: "58" }), [provider]).complete(request, stream, "ar"))
      .rejects.toThrow(/matched the transcribed audio/);
  });

  it("skips a rejected subtitle and returns a different one", async () => {
    const arabic = (label: string) => serializeSrt(sourceCues.map((cue) => ({
      ...cue,
      startMs: cue.startMs - 2_500,
      endMs: cue.endMs - 2_500,
      text: `${label} ${cue.id}`,
    })));
    const provider = new FakeProvider("fake", new Map([
      ["en-1", { language: "en", content: serializeSrt(sourceCues) }],
      ["ar-1", { language: "ar", content: arabic("أول") }],
      ["ar-2", { language: "ar", content: arabic("ثاني") }],
    ]));
    const pipeline = new AutoSubPipeline(await config(), [provider]);

    const first = await pipeline.complete(request, stream, "ar");
    const second = await pipeline.complete(request, stream, "ar", [first.id]);
    expect(second.id).not.toBe(first.id);
    expect(second.content).not.toContain(first.content.split("\n")[2]);
  });

  it("reuses the audio probe when preparing an alternative", async () => {
    const provider = new FakeProvider("fake", new Map([
      ["en-1", { language: "en", content: serializeSrt(sourceCues) }],
      ["ar-1", { language: "ar", content: serializeSrt(sourceCues.map((cue) => ({ ...cue, text: `أ ${cue.id}` }))) }],
      ["ar-2", { language: "ar", content: serializeSrt(sourceCues.map((cue) => ({ ...cue, text: `ب ${cue.id}` }))) }],
    ]));
    const pipeline = new AutoSubPipeline(await config(), [provider]);
    const first = await pipeline.complete(request, stream, "ar");
    await pipeline.complete(request, stream, "ar", [first.id]);
    // Re-sampling the release would cost another ffmpeg pass over the network.
    expect(analyses.count).toBe(1);
  });

  it("keeps a rejected translation from being produced again", async () => {
    const provider = new FakeProvider("fake", new Map([
      ["en-1", { language: "en", content: serializeSrt(sourceCues) }],
    ]));
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { contents: Array<{ parts: Array<{ text: string }> }> };
      const cues = JSON.parse(body.contents[0].parts[0].text.split("Cues: ")[1]) as Array<{ id: number }>;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(cues.map((cue) => ({ id: cue.id, text: `مترجم ${cue.id}` }))) }] } }],
      }), { status: 200 });
    }));
    const pipeline = new AutoSubPipeline(await config({ GEMINI_API_KEY: "test-key" }), [provider]);

    const translated = await pipeline.complete(request, stream, "ar");
    expect(translated.id).toBe("gemini:fake:en-1");
    // The only usable source track is barred, so there is nothing left to offer.
    await expect(pipeline.complete(request, stream, "ar", [translated.id]))
      .rejects.toThrow(/matched the transcribed audio/);
  });

  it("analyses the release once when two languages start together", async () => {
    const provider = new FakeProvider("fake", new Map([
      ["en-1", { language: "en", content: serializeSrt(sourceCues) }],
      ["ar-1", { language: "ar", content: serializeSrt(sourceCues.map((cue) => ({ ...cue, text: `أ ${cue.id}` }))) }],
    ]));
    const pipeline = new AutoSubPipeline(await config(), [provider]);
    await Promise.all([
      pipeline.complete(request, stream, "ar"),
      pipeline.complete({ ...request, languages: ["en"] }, stream, "en"),
    ]);
    expect(analyses.count).toBe(1);
  });

  it("downloads each candidate once despite prefetching", async () => {
    const provider = new FakeProvider("fake", new Map([
      ["en-1", { language: "en", content: serializeSrt(sourceCues) }],
      ["ar-1", { language: "ar", content: serializeSrt(sourceCues.map((cue) => ({ ...cue, text: `أ ${cue.id}` }))) }],
    ]));
    await new AutoSubPipeline(await config(), [provider]).complete(request, stream, "ar");
    expect(provider.downloads).toBe(2);
  });

  it("records what each run cost", async () => {
    const provider = new FakeProvider("fake", new Map([
      ["en-1", { language: "en", content: serializeSrt(sourceCues) }],
      ["ar-1", { language: "ar", content: serializeSrt(sourceCues.map((cue) => ({ ...cue, text: `أ ${cue.id}` }))) }],
    ]));
    const pipeline = new AutoSubPipeline(await config(), [provider]);
    await pipeline.complete(request, stream, "ar");
    await pipeline.complete(request, stream, "ar");

    const [latest, first] = pipeline.recentRuns();
    expect(latest.outcome).toBe("cached");
    expect(first.outcome).toBe("direct");
    expect(first.contentId).toBe("tt1");
    expect(Object.keys(first.stages)).toContain("audio");
    expect(first.totalMs).toBeGreaterThanOrEqual(0);
  });

  it("identifies a release the same way however it was asked for", async () => {
    // The play redirect knows only the stream; the subtitle list may also carry
    // a filename. Both must name the same job or the pipeline runs twice.
    const pipeline = new AutoSubPipeline(await config(), []);
    const fromPlay = pipeline.releaseKey({ type: "movie", contentId: "tt1", languages: ["ar"] }, stream, "ar");
    const fromList = pipeline.releaseKey(
      { type: "movie", contentId: "tt1", languages: ["ar"], filename: stream.filename, videoSize: 42 },
      stream,
      "ar",
    );
    expect(fromList).toBe(fromPlay);
    expect(pipeline.releaseKey(request, { ...stream, filename: "Other.mkv", url: "https://d/other" }, "ar")).not.toBe(fromPlay);
    expect(pipeline.releaseKey(request, stream, "en")).not.toBe(fromPlay);
  });

  it("refuses to run at all when audio analysis is disabled", async () => {
    const provider = new FakeProvider("fake", new Map());
    await expect(new AutoSubPipeline(await config({ AUDIO_ANALYSIS_ENABLED: "false" }), [provider]).complete(request, stream, "ar"))
      .rejects.toThrow(/Audio analysis is disabled/);
  });
});
