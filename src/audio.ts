import type { AppConfig } from "./config.js";
import type { AudioProbeResult, SpeechInterval, StreamRecord, TranscriptWord, VadWindow } from "./domain.js";
import { request } from "./http.js";
import { normalizeLanguage } from "./languages.js";
import { runProcess } from "./process.js";

interface ProbeStream {
  index: number;
  codec_type?: string;
  tags?: { language?: string; title?: string };
  disposition?: { default?: number };
}

interface Transcription {
  language?: string;
  transcript?: string;
  words?: TranscriptWord[];
}

interface Sample {
  window: VadWindow;
  pcm: Buffer;
}

const SAMPLE_RATE = 16_000;
const FRAME_MS = 30;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const PROBE_TIMEOUT_MS = 40_000;
const VAD_TIMEOUT_MS = 20_000;
const TRANSCRIBE_TIMEOUT_MS = 20_000;
const MINIMUM_WINDOWS = 3;
const MINIMUM_TRANSCRIPTS = 3;

function safeHeaders(headers?: Record<string, string>): string | undefined {
  if (!headers) return undefined;
  // A newline in a header value would let a compromised upstream inject extra
  // ffmpeg header lines, so those entries are dropped rather than escaped.
  const lines = Object.entries(headers)
    .filter(([key, value]) => !/[\r\n]/.test(key) && !/[\r\n]/.test(value))
    .map(([key, value]) => `${key}: ${value}`);
  return lines.length ? `${lines.join("\r\n")}\r\n` : undefined;
}

/**
 * Fallback speech detection for when WebRTC VAD is unavailable.
 *
 * Frames are classified against a noise-floor-relative threshold, then smoothed
 * with a sliding count so a single loud frame is not reported as speech.
 */
export function energyVad(pcm: Buffer, sampleRate = SAMPLE_RATE): SpeechInterval[] {
  const frameSamples = Math.round(sampleRate * (FRAME_MS / 1000));
  const frameBytes = frameSamples * 2;
  const frames = Math.floor(pcm.length / frameBytes);
  if (frames < 1) return [];

  const energies = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * frameBytes;
    let sum = 0;
    for (let index = 0; index < frameSamples; index += 1) {
      const sample = pcm.readInt16LE(offset + index * 2);
      sum += sample * sample;
    }
    energies[frame] = Math.sqrt(sum / frameSamples);
  }

  const sorted = energies.slice().sort();
  const noise = sorted[Math.floor(frames * 0.25)] || 0;
  const threshold = Math.max(380, noise * 2.6);

  // Prefix sums turn the ±2 frame neighbourhood vote into O(1) per frame.
  const active = new Uint8Array(frames);
  const prefix = new Int32Array(frames + 1);
  for (let frame = 0; frame < frames; frame += 1) {
    active[frame] = energies[frame] >= threshold ? 1 : 0;
    prefix[frame + 1] = prefix[frame] + active[frame];
  }

  const intervals: SpeechInterval[] = [];
  let start = -1;
  for (let frame = 0; frame <= frames; frame += 1) {
    const from = Math.max(0, frame - 2);
    const to = Math.min(frames, frame + 3);
    const voiced = frame < frames && prefix[to] - prefix[from] >= 2;
    if (voiced && start < 0) start = frame;
    if (!voiced && start >= 0) {
      if (frame - start >= 3) intervals.push({ startMs: start * FRAME_MS, endMs: frame * FRAME_MS });
      start = -1;
    }
  }
  return intervals;
}

/**
 * Samples the selected audio track and describes where speech happens.
 *
 * Only a few short windows are read — never the whole file — which is what
 * keeps bandwidth and CPU on a Raspberry Pi within budget while still giving
 * the aligner enough evidence to accept or reject a subtitle.
 */
export class AudioAnalyzer {
  constructor(private readonly config: AppConfig) {}

  private async resolveMediaUrl(stream: StreamRecord): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      // Following the debrid redirect once here means ffprobe and every ffmpeg
      // sample skip the resolver round trip.
      const response = await fetch(stream.url, {
        method: "GET",
        redirect: "manual",
        headers: stream.requestHeaders,
        signal: controller.signal,
      });
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (response.status >= 300 && response.status < 400 && location) {
        const resolved = new URL(location, stream.url);
        if (resolved.protocol === "http:" || resolved.protocol === "https:") return resolved.toString();
      }
    } catch (error) {
      console.warn("Media pre-resolution failed; using the original resolver URL:", error instanceof Error ? error.message : error);
    } finally {
      clearTimeout(timer);
    }
    return stream.url;
  }

  private async vad(pcm: Buffer): Promise<SpeechInterval[]> {
    try {
      const result = await runProcess(this.config.pythonPath, [this.config.vadScriptPath, "--sample-rate", String(SAMPLE_RATE)], {
        input: pcm,
        timeoutMs: VAD_TIMEOUT_MS,
        maxOutputBytes: 2 * 1024 * 1024,
      });
      const parsed = JSON.parse(result.stdout.toString("utf8")) as { intervals?: SpeechInterval[] };
      if (Array.isArray(parsed.intervals)) return parsed.intervals;
    } catch (error) {
      console.warn("WebRTC VAD unavailable; using energy VAD:", error instanceof Error ? error.message : error);
    }
    return energyVad(pcm);
  }

  private async transcribeOnce(pcm: Buffer, languageHint?: string): Promise<Transcription> {
    if (!this.config.deepgram.apiKey) return {};
    const url = new URL("https://api.deepgram.com/v1/listen");
    url.searchParams.set("model", this.config.deepgram.model);
    if (languageHint) url.searchParams.set("language", languageHint);
    else url.searchParams.set("detect_language", "true");
    url.searchParams.set("smart_format", "true");
    url.searchParams.set("encoding", "linear16");
    url.searchParams.set("sample_rate", String(SAMPLE_RATE));
    url.searchParams.set("channels", "1");

    try {
      const response = await request(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${this.config.deepgram.apiKey}`,
          "Content-Type": "application/octet-stream",
        },
        body: pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
        label: "Deepgram transcription",
      });
      const body = await response.json() as {
        results?: { channels?: Array<{
          detected_language?: string;
          alternatives?: Array<{
            transcript?: string;
            words?: Array<{ word?: string; start?: number; end?: number; confidence?: number; language?: string }>;
          }>;
        }> };
      };
      const channel = body.results?.channels?.[0];
      const alternative = channel?.alternatives?.[0];
      return {
        language: normalizeLanguage(channel?.detected_language) || normalizeLanguage(languageHint),
        transcript: alternative?.transcript?.trim() || undefined,
        words: alternative?.words?.flatMap((word) => {
          if (!word.word || !Number.isFinite(word.start) || !Number.isFinite(word.end)) return [];
          return [{
            word: word.word,
            startMs: Math.round(Number(word.start) * 1000),
            endMs: Math.round(Number(word.end) * 1000),
            confidence: word.confidence,
            language: normalizeLanguage(word.language),
          } satisfies TranscriptWord];
        }),
      };
    } catch (error) {
      console.warn("Deepgram transcription failed:", error instanceof Error ? error.message : error);
      return {};
    }
  }

  private async transcribe(pcm: Buffer, languageHint?: string): Promise<Transcription> {
    const result = await this.transcribeOnce(pcm, languageHint);
    // TMDB/container language tags are usually right, but releases are often
    // mislabeled. Retry using Deepgram detection only when the explicit model
    // produced no speech, so correct non-English tracks do not pay extra time.
    if (languageHint && !result.transcript) return this.transcribeOnce(pcm);
    return result;
  }

  private selectStream(streams: ProbeStream[], preferred?: string): ProbeStream {
    return streams.find((item) => normalizeLanguage(item.tags?.language) === preferred && Boolean(preferred))
      || streams.find((item) => /original/i.test(item.tags?.title || ""))
      || streams.find((item) => item.disposition?.default === 1)
      || streams[0];
  }

  private async probe(mediaUrl: string, headers?: string): Promise<{ durationMs: number; streams: ProbeStream[] }> {
    const args = ["-v", "error"];
    if (headers) args.push("-headers", headers);
    args.push(
      "-show_entries", "format=duration:stream=index,codec_type:stream_tags=language,title:stream_disposition=default",
      "-of", "json", mediaUrl,
    );
    const result = await runProcess(this.config.ffprobePath, args, { timeoutMs: PROBE_TIMEOUT_MS, maxOutputBytes: 2 * 1024 * 1024 });
    const data = JSON.parse(result.stdout.toString("utf8")) as { format?: { duration?: string }; streams?: ProbeStream[] };
    const durationMs = Math.round(Number(data.format?.duration) * 1000);
    if (!Number.isFinite(durationMs) || durationMs < 60_000) throw new Error("Could not determine media duration");
    return { durationMs, streams: data.streams || [] };
  }

  private sampler(mediaUrl: string, headers: string | undefined, streamIndex: number, seconds: number) {
    return async (startMs: number): Promise<Sample | undefined> => {
      const args = ["-v", "error", "-ss", (startMs / 1000).toFixed(3)];
      if (headers) args.push("-headers", headers);
      args.push("-i", mediaUrl, "-t", String(seconds), "-map", `0:${streamIndex}`, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "pipe:1");
      try {
        const extraction = await runProcess(this.config.ffmpegPath, args, {
          timeoutMs: Math.max(45_000, seconds * 2_000),
          maxOutputBytes: Math.ceil(seconds * BYTES_PER_SECOND * 1.1),
        });
        if (extraction.stdout.length < SAMPLE_RATE) return undefined;
        return {
          pcm: extraction.stdout,
          window: {
            startMs: Math.round(startMs),
            durationMs: Math.round((extraction.stdout.length / BYTES_PER_SECOND) * 1000),
            speech: await this.vad(extraction.stdout),
          },
        };
      } catch (error) {
        console.warn("Audio sample failed:", error instanceof Error ? error.message : error);
        return undefined;
      }
    };
  }

  /** Runs samples in bounded waves; remote range seeks dominate cold-start latency. */
  private async collect(starts: number[], sample: (startMs: number) => Promise<Sample | undefined>): Promise<Sample[]> {
    const collected: Sample[] = [];
    const size = this.config.audioConcurrency;
    for (let index = 0; index < starts.length; index += size) {
      const wave = await Promise.all(starts.slice(index, index + size).map(sample));
      for (const item of wave) if (item) collected.push(item);
    }
    return collected;
  }

  private async attachTranscripts(samples: Sample[], languageHint: string | undefined): Promise<string | undefined> {
    const transcriptions = await Promise.all(samples.map((item) => this.transcribe(item.pcm, languageHint)));
    let detected: string | undefined;
    for (let index = 0; index < samples.length; index += 1) {
      samples[index].window.transcript = transcriptions[index].transcript;
      samples[index].window.words = transcriptions[index].words;
      detected ||= transcriptions[index].language;
    }
    return detected;
  }

  async analyze(stream: StreamRecord, preferredLanguage?: string): Promise<AudioProbeResult> {
    const started = Date.now();
    const mediaUrl = await this.resolveMediaUrl(stream);
    const headers = safeHeaders(stream.requestHeaders);
    const { durationMs, streams } = await this.probe(mediaUrl, headers);

    const audioStreams = streams.filter((item) => item.codec_type === "audio");
    if (!audioStreams.length) throw new Error("Media contains no audio stream");
    const preferred = normalizeLanguage(preferredLanguage);
    const selected = this.selectStream(audioStreams, preferred);
    let audioLanguage = normalizeLanguage(selected.tags?.language);

    const count = Math.max(MINIMUM_WINDOWS + 1, this.config.audioSampleCount);
    const seconds = Math.min(this.config.audioSampleSeconds, Math.max(20, durationMs / 1000 / (count + 2)));
    // Skip credits at both ends: the opening logos and the closing crawl carry
    // little dialogue and often differ between releases.
    const usableStart = Math.min(120_000, durationMs * 0.04);
    const usableEnd = Math.max(usableStart, (durationMs * 0.92) - (seconds * 1000));
    const starts = Array.from({ length: count }, (_, index) => usableStart + ((usableEnd - usableStart) * index / Math.max(1, count - 1)));

    const sample = this.sampler(mediaUrl, headers, selected.index, seconds);
    const samples = await this.collect(starts, sample);
    // A container language tag stays authoritative; detection only fills a gap.
    const detected = await this.attachTranscripts(samples, preferred || audioLanguage);
    audioLanguage ||= detected;

    // Quiet windows are common (action scenes, music). Replace a few rather
    // than failing the whole title.
    if (samples.filter((item) => item.window.transcript).length < MINIMUM_TRANSCRIPTS) {
      const alternatives = [0.18, 0.48, 0.76]
        .map((fraction) => usableStart + ((usableEnd - usableStart) * fraction))
        .filter((startMs) => starts.every((existing) => Math.abs(existing - startMs) > seconds * 2_000))
        .slice(0, 2);
      const retries = await this.collect(alternatives, sample);
      const retryLanguage = await this.attachTranscripts(retries, preferred || audioLanguage);
      audioLanguage ||= retryLanguage;
      samples.push(...retries);
    }

    const windows = samples.map((item) => item.window).sort((left, right) => left.startMs - right.startMs);
    if (windows.length < MINIMUM_WINDOWS) throw new Error("Not enough audio samples could be read from the selected stream");
    const transcripts = windows.filter((window) => window.transcript).length;
    console.log(`Audio analysis completed with ${windows.length} windows (${starts.length} primary) and ${transcripts} transcripts; language=${audioLanguage || "unknown"}; elapsed=${Date.now() - started}ms`);
    return { durationMs, audioLanguage, audioStreamIndex: selected.index, windows };
  }
}
