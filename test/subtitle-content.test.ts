import { zipSync } from "fflate";
import iconv from "iconv-lite";
import { describe, expect, it } from "vitest";
import type { SubtitleCandidate } from "../src/domain.js";
import { prepareSubtitle } from "../src/subtitle-content.js";

const candidate = (locator: SubtitleCandidate["locator"] = {}): SubtitleCandidate => ({
  provider: "subsource",
  providerId: "1",
  language: "ar",
  filename: "subtitle.srt",
  locator,
});

const srt = (text: string): string => `1\n00:00:01,000 --> 00:00:02,500\n${text}\n`;
const bytes = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, "utf8"));

describe("subtitle preparation", () => {
  it("passes through a plain SRT", () => {
    expect(prepareSubtitle(bytes(srt("hello")), candidate())).toContain("00:00:01,000 --> 00:00:02,500");
  });

  it("converts ASS dialogue, dropping styling overrides", () => {
    const ass = [
      "[Script Info]",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      "Dialogue: 0,0:00:03.50,0:00:05.00,Default,,0,0,0,,{\\pos(1,2)}First line\\NSecond, with comma",
    ].join("\n");
    const result = prepareSubtitle(bytes(ass), candidate());
    expect(result).toContain("00:00:03,500 --> 00:00:05,000");
    expect(result).toContain("First line\nSecond, with comma");
    expect(result).not.toContain("\\pos");
  });

  it("converts WebVTT cues and their fractional timestamps", () => {
    const vtt = "WEBVTT\n\n00:00:02.000 --> 00:00:04.000 align:start\nCaption text\n";
    expect(prepareSubtitle(bytes(vtt), candidate())).toContain("00:00:02,000 --> 00:00:04,000");
  });

  it("decodes windows-1256 Arabic that is not valid UTF-8", () => {
    const arabic = srt("مرحبا بالعالم");
    const encoded = new Uint8Array(iconv.encode(arabic, "windows-1256"));
    expect(prepareSubtitle(encoded, candidate())).toContain("مرحبا بالعالم");
  });

  it("picks the requested episode out of a season archive", () => {
    const archive = zipSync({
      "Show.S02E07.srt": bytes(srt("episode seven")),
      "Show.S02E08.srt": bytes(srt("episode eight")),
    });
    expect(prepareSubtitle(archive, candidate({ episode: 8 }))).toContain("episode eight");
  });

  it("ignores macOS resource forks inside archives", () => {
    // These sort first in many archives and decode to binary noise.
    const archive = zipSync({
      "__MACOSX/._Movie.srt": new Uint8Array([0, 5, 22, 7, 255, 254]),
      "Movie.srt": bytes(srt("real subtitle")),
    });
    expect(prepareSubtitle(archive, candidate())).toContain("real subtitle");
  });

  it("prefers the full track over a sample track", () => {
    const archive = zipSync({
      "Movie.sample.srt": bytes(srt("sample")),
      "Movie.srt": bytes(`${srt("full")}\n2\n00:00:05,000 --> 00:00:06,000\nmore\n`),
    });
    expect(prepareSubtitle(archive, candidate())).toContain("full");
  });

  it("rejects a download that is not a timed subtitle", () => {
    expect(() => prepareSubtitle(bytes("<html>not found</html>"), candidate())).toThrow(/not a valid timed subtitle/);
  });

  it("rejects an archive with no supported subtitle", () => {
    const archive = zipSync({ "readme.txt": bytes("nothing here") });
    expect(() => prepareSubtitle(archive, candidate())).toThrow(/no supported text subtitle/);
  });
});
