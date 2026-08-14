import { describe, expect, it } from "vitest";
import { parseSrt, serializeSrt, stabilizeCues } from "../src/srt.js";

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

describe("cue stabilization", () => {
  it("merges overlapping duplicate cues instead of flashing them twice", () => {
    const result = stabilizeCues([
      { id: 1, startMs: 1_000, endMs: 2_000, text: "  مرحبا  " },
      { id: 2, startMs: 1_950, endMs: 3_000, text: "مرحبا" },
    ]);
    expect(result.cues).toEqual([{ id: 1, startMs: 1_000, endMs: 3_000, text: "مرحبا" }]);
    expect(result.merged).toBe(1);
  });

  it("merges identical captions separated by a sub-frame playback gap", () => {
    const result = stabilizeCues([
      { id: 1, startMs: 1_000, endMs: 2_000, text: "نفس السطر" },
      { id: 2, startMs: 2_200, endMs: 3_200, text: "نفس السطر" },
    ]);
    expect(result.cues).toEqual([{ id: 1, startMs: 1_000, endMs: 3_200, text: "نفس السطر" }]);
    expect(result.merged).toBe(1);
  });

  it("merges duplicate and progressive captions even when another overlay sits between them", () => {
    const result = stabilizeCues([
      { id: 1, startMs: 1_000, endMs: 3_000, text: "Hello" },
      { id: 2, startMs: 1_050, endMs: 2_000, text: "[door opens]" },
      { id: 3, startMs: 1_080, endMs: 3_500, text: "Hello" },
      { id: 4, startMs: 5_000, endMs: 6_000, text: "How" },
      { id: 5, startMs: 5_050, endMs: 7_000, text: "How are you?" },
    ]);
    expect(result.cues.map((cue) => cue.text)).toEqual(["Hello", "[door opens]", "How are you?"]);
    expect(result.merged).toBe(2);
  });

  it("drops one-frame junk and extends short readable cues when space permits", () => {
    const result = stabilizeCues([
      { id: 1, startMs: 1_000, endMs: 1_080, text: "flash" },
      { id: 2, startMs: 2_000, endMs: 2_250, text: "kept" },
      { id: 3, startMs: 4_000, endMs: 5_000, text: "next" },
    ]);
    expect(result.cues.map((cue) => cue.text)).toEqual(["kept", "next"]);
    expect(result.cues[0].endMs - result.cues[0].startMs).toBe(500);
  });

  it("keeps meaningful multi-speaker overlaps", () => {
    const result = stabilizeCues([
      { id: 1, startMs: 1_000, endMs: 3_000, text: "- First speaker" },
      { id: 2, startMs: 2_000, endMs: 4_000, text: "- Second speaker" },
    ]);
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0].endMs).toBe(3_000);
  });

  it("removes control-only cues and returns chronological ids", () => {
    const result = stabilizeCues([
      { id: 9, startMs: 4_000, endMs: 5_000, text: "later" },
      { id: 8, startMs: 1_000, endMs: 2_000, text: "\u0000\u200b" },
      { id: 7, startMs: 2_000, endMs: 3_000, text: "earlier" },
    ]);
    expect(result.cues.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: 1, text: "earlier" },
      { id: 2, text: "later" },
    ]);
  });
});
