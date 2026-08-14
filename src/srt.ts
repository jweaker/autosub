import type { SubtitleCue } from "./domain.js";

const MINIMUM_VISIBLE_MS = 500;
const DROP_BELOW_MS = 160;
const SAME_TEXT_GAP_MS = 250;
const SMALL_OVERLAP_MS = 180;

export interface CueCleanup {
  cues: SubtitleCue[];
  removed: number;
  merged: number;
  adjusted: number;
}

function cleanText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function textKey(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/<[^>]+>/g, "")
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

/**
 * Removes the timing pathologies that make otherwise-correct subtitles flash.
 *
 * Provider files commonly contain duplicate cues, zero-width-only text,
 * one-frame cues, and tiny accidental overlaps. The aligner should see the
 * same stable timeline the player will render, so cleanup happens before
 * validation and once more after the final global timing correction.
 * Meaningful overlaps (two people speaking together) are deliberately kept.
 */
export function stabilizeCues(input: SubtitleCue[]): CueCleanup {
  let removed = 0;
  let merged = 0;
  let adjusted = 0;
  const sorted = input
    .map((cue) => ({ ...cue, text: cleanText(cue.text) }))
    .filter((cue) => {
      const keep = Boolean(textKey(cue.text)) && Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs) && cue.endMs > cue.startMs;
      if (!keep) removed += 1;
      return keep;
    })
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

  const deduplicated: SubtitleCue[] = [];
  for (const cue of sorted) {
    const previous = deduplicated.at(-1);
    const key = textKey(cue.text);
    let duplicate: SubtitleCue | undefined;
    for (let index = deduplicated.length - 1; index >= 0; index -= 1) {
      const candidate = deduplicated[index];
      if (candidate.endMs + SAME_TEXT_GAP_MS < cue.startMs) break;
      if (textKey(candidate.text) === key) {
        duplicate = candidate;
        break;
      }
    }
    if (duplicate) {
      duplicate.startMs = Math.min(duplicate.startMs, cue.startMs);
      duplicate.endMs = Math.max(duplicate.endMs, cue.endMs);
      merged += 1;
      continue;
    }
    if (previous && Math.abs(previous.startMs - cue.startMs) <= SAME_TEXT_GAP_MS) {
      const previousKey = textKey(previous.text);
      if (key.startsWith(previousKey) || previousKey.startsWith(key)) {
        previous.startMs = Math.min(previous.startMs, cue.startMs);
        previous.endMs = Math.max(previous.endMs, cue.endMs);
        if (key.length > previousKey.length) previous.text = cue.text;
        merged += 1;
        continue;
      }
    }
    deduplicated.push({ ...cue });
  }

  const visible: SubtitleCue[] = [];
  for (let index = 0; index < deduplicated.length; index += 1) {
    const cue = deduplicated[index];
    const duration = cue.endMs - cue.startMs;
    if (duration < DROP_BELOW_MS) {
      removed += 1;
      continue;
    }
    const next = deduplicated[index + 1];
    if (duration < MINIMUM_VISIBLE_MS) {
      const availableEnd = next ? next.startMs - 20 : cue.startMs + MINIMUM_VISIBLE_MS;
      const extended = Math.min(cue.startMs + MINIMUM_VISIBLE_MS, availableEnd);
      if (extended > cue.endMs) {
        cue.endMs = extended;
        adjusted += 1;
      }
    }
    visible.push(cue);
  }

  // Remove only incidental overlaps. Larger overlaps are normally intentional
  // multi-speaker or sign/dialogue combinations and must survive.
  for (let index = 0; index + 1 < visible.length; index += 1) {
    const cue = visible[index];
    const next = visible[index + 1];
    const overlap = cue.endMs - next.startMs;
    if (overlap > 0 && overlap <= SMALL_OVERLAP_MS && next.startMs - cue.startMs >= MINIMUM_VISIBLE_MS) {
      cue.endMs = next.startMs;
      adjusted += 1;
    }
  }

  return {
    cues: visible.map((cue, index) => ({ ...cue, id: index + 1 })),
    removed,
    merged,
    adjusted,
  };
}

function timestampMs(value: string): number {
  const match = value.trim().match(/^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) throw new Error(`Invalid subtitle timestamp: ${value}`);
  return (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4]);
}

function formatTimestamp(value: number): string {
  const total = Math.max(0, Math.round(value));
  const ms = total % 1000;
  const seconds = Math.floor(total / 1000) % 60;
  const minutes = Math.floor(total / 60_000) % 60;
  const hours = Math.floor(total / 3_600_000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function parseSrt(input: string): SubtitleCue[] {
  const blocks = input.replace(/^\uFEFF/, "").replace(/\r/g, "").trim().split(/\n{2,}/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].match(/(\d{1,3}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{3})/);
    if (!timing) continue;
    const text = lines.slice(timingIndex + 1).join("\n").trim();
    if (!text) continue;
    const startMs = timestampMs(timing[1]);
    const endMs = timestampMs(timing[2]);
    if (endMs <= startMs) continue;
    cues.push({ id: cues.length + 1, startMs, endMs, text });
  }
  if (!cues.length) throw new Error("Subtitle contains no parseable cues");
  return cues;
}

export function serializeSrt(cues: SubtitleCue[]): string {
  return `${cues.map((cue, index) => `${index + 1}\n${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}\n${cue.text.trim()}`).join("\n\n")}\n`;
}
