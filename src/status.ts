import type { CompletedSubtitle, SubtitleCue } from "./domain.js";
import { languageName } from "./languages.js";
import { serializeSrt } from "./srt.js";

const BANNER_START_MS = 300;
const BANNER_LENGTH_MS = 6_000;
const BANNER_MINIMUM_MS = 1_500;
const NOTICE_INTERVAL_MS = 30_000;
const NOTICE_LENGTH_MS = 5_000;
const NOTICE_DEFAULT_DURATION_MS = 3 * 60 * 60 * 1000;

/**
 * Labels are shown in Stremio's subtitle menu on TVs whose fonts are often
 * limited, so they stay plain ASCII rather than using symbols that may render
 * as empty boxes.
 */
export function resultLabel(result: CompletedSubtitle): string {
  return result.translated
    ? `AutoSub: AI translated from ${languageName(result.sourceLanguage || "")} (${result.confidence}%)`
    : `AutoSub: found on ${result.provider} (${result.confidence}%)`;
}

export function failedLabel(): string {
  return "AutoSub: nothing matched this release";
}

/**
 * Reads as a language row because the protocol has no other place to put it,
 * so it names the language first and the action second.
 *
 * Attempts are numbered because each one is a separate row with its own URL:
 * a player will not re-request a track it already has, so a single row could
 * only ever be used once per playback.
 */
export function retryLabel(language: string, attempt = 1): string {
  return `${languageName(language)} - try another${attempt > 1 ? ` #${attempt}` : ""} (AutoSub)`;
}

export function translateLabel(language: string): string {
  return `${languageName(language)} - AI translate, uses credits (AutoSub)`;
}

export function translationOfferTrack(language: string): string {
  return noticeTrack([
    `[AutoSub] No ${languageName(language)} subtitle matched this release.`,
    `Pick "${translateLabel(language)}" in the subtitle menu to have one translated.`,
  ]);
}

/** One-line summary of what was delivered, shown briefly at the start of playback. */
export function bannerText(result: CompletedSubtitle): string {
  const origin = result.translated
    ? `AI translation from ${languageName(result.sourceLanguage || "")}`
    : `${result.provider} subtitle`;
  return `[AutoSub] ${origin} - ${result.confidence}% match. Wrong one? Pick "try another" in the subtitle menu.`;
}

/**
 * Prepends the banner to a finished track.
 *
 * The banner is dropped rather than shortened when dialogue starts immediately,
 * because overlapping the first real cue is worse than saying nothing.
 */
export function withBanner(cues: SubtitleCue[], text: string): SubtitleCue[] {
  const firstStart = cues[0]?.startMs ?? Number.POSITIVE_INFINITY;
  const endMs = Math.min(BANNER_START_MS + BANNER_LENGTH_MS, firstStart - 200);
  if (endMs - BANNER_START_MS < BANNER_MINIMUM_MS) return cues;
  return [{ id: 0, startMs: BANNER_START_MS, endMs, text }, ...cues];
}

/**
 * A subtitle file whose only content is a message.
 *
 * Stremio has no way to show "still working" on its own, and a failed request
 * shows nothing at all, so status is delivered the one way a player always
 * renders: as cues. They repeat because the viewer may be anywhere in the
 * title when they select the track.
 */
export function noticeTrack(lines: string[], durationMs = NOTICE_DEFAULT_DURATION_MS): string {
  const text = lines.join("\n");
  const cues: SubtitleCue[] = [];
  for (let startMs = 1_000; startMs < durationMs; startMs += NOTICE_INTERVAL_MS) {
    cues.push({ id: cues.length + 1, startMs, endMs: startMs + NOTICE_LENGTH_MS, text });
  }
  return serializeSrt(cues);
}

export function preparingTrack(language: string): string {
  return noticeTrack([
    `[AutoSub] Still preparing the ${languageName(language)} subtitle.`,
    "Reselect it from the subtitle menu in a moment.",
  ]);
}

export function failureTrack(reason: string): string {
  return noticeTrack([
    "[AutoSub] No subtitle passed audio validation for this release.",
    reason,
  ]);
}

export function exhaustedTrack(language: string): string {
  return noticeTrack([
    `[AutoSub] No other ${languageName(language)} subtitle passed validation.`,
    "The previous one was kept as the best available match.",
  ]);
}
