import { describe, expect, it } from "vitest";
import { parseSrt, serializeSrt } from "../src/srt.js";

describe("SRT parsing", () => {
  it("round trips multilingual cues", () => {
    const input = "1\n00:00:01,200 --> 00:00:03,400\nمرحباً\n\n2\n00:01:00,000 --> 00:01:02,000\nこんにちは\n";
    const cues = parseSrt(input);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe("مرحباً");
    expect(serializeSrt(cues)).toContain("00:01:00,000 --> 00:01:02,000");
  });

  it("tolerates a BOM, CRLF line endings, and dot-separated milliseconds", () => {
    const cues = parseSrt("﻿1\r\n00:00:01.000 --> 00:00:02.000\r\nHello\r\n");
    expect(cues).toEqual([{ id: 1, startMs: 1_000, endMs: 2_000, text: "Hello" }]);
  });

  it("skips blocks that are empty or impossible", () => {
    const cues = parseSrt([
      "1\n00:00:05,000 --> 00:00:04,000\nends before it starts",
      "2\n00:00:06,000 --> 00:00:07,000\n",
      "3\nno timing line here",
      "4\n00:00:08,000 --> 00:00:09,000\nkept",
    ].join("\n\n"));
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ id: 1, text: "kept" });
  });

  it("renumbers cues on output", () => {
    const output = serializeSrt([
      { id: 40, startMs: 1_000, endMs: 2_000, text: "first" },
      { id: 41, startMs: 3_000, endMs: 4_000, text: "second" },
    ]);
    expect(output.startsWith("1\n")).toBe(true);
    expect(output).toContain("\n2\n");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("formats hours beyond a single digit", () => {
    expect(serializeSrt([{ id: 1, startMs: 36_000_000, endMs: 36_001_500, text: "late" }]))
      .toContain("10:00:00,000 --> 10:00:01,500");
  });

  it("rejects a file with no cues at all", () => {
    expect(() => parseSrt("not a subtitle")).toThrow(/no parseable cues/);
  });
});
