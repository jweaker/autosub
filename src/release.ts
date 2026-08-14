import type { ReleaseSignature } from "./domain.js";

const SOURCE_PATTERNS: Array<[ReleaseSignature["source"], RegExp]> = [
  ["bluray", /\b(?:blu[ ._-]?ray|b[dr]rip|(?:bd|uhd[ ._-]?bd)?remux|remux)\b/i],
  ["web", /\b(?:web[ ._-]?(?:dl|rip)?|webrip)\b/i],
  ["hdtv", /\bhdtv\b/i],
  ["dvd", /\b(?:dvd(?:rip)?|dvdrip)\b/i],
];

const EDITIONS = ["extended", "directors cut", "director cut", "theatrical", "uncut", "remastered", "imax"];

const EXTENSION = /\.[a-z0-9]{2,4}$/i;

export function normalizeReleaseName(value: string): string {
  return value
    .replace(EXTENSION, "")
    // Hyphens separate tokens as much as dots do ("x264-GROUP"), so they are
    // split too; the source patterns below tolerate the resulting spaces.
    .replace(/[._-]+/g, " ")
    .replace(/[\[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function parseRelease(value?: string): ReleaseSignature | undefined {
  if (!value) return undefined;
  const normalized = normalizeReleaseName(value);
  const source = SOURCE_PATTERNS.find(([, pattern]) => pattern.test(normalized))?.[0];
  const episodeMatch = normalized.match(/\bs(\d{1,3})e(\d{1,3})\b/i);
  const edition = EDITIONS.find((candidate) => normalized.includes(candidate));
  const fpsMatch = normalized.match(/\b(23\.976|24(?:\.000)?|25(?:\.000)?|29\.97|30(?:\.000)?)\s*fps\b/i);
  // The release group is the last hyphen-delimited token, once any file
  // extension is gone. Anchoring at the end keeps "WEB-DL" from being read as
  // the group of "...WEB-DL.DDP5.1-TEAM.mkv".
  const groupMatch = value.replace(EXTENSION, "").match(/-([A-Za-z0-9]{2,20})$/);

  return {
    normalized,
    source,
    edition,
    group: groupMatch?.[1]?.toLowerCase(),
    fps: fpsMatch ? Number.parseFloat(fpsMatch[1]) : undefined,
    season: episodeMatch ? Number.parseInt(episodeMatch[1], 10) : undefined,
    episode: episodeMatch ? Number.parseInt(episodeMatch[2], 10) : undefined,
  };
}

export function tokenSimilarity(left: string, right: string): number {
  const ignored = new Set(["1080p", "2160p", "720p", "x264", "x265", "h264", "h265", "hevc", "hdr", "dv", "uhd", "aac", "dts"]);
  const tokens = (value: string) =>
    new Set(normalizeReleaseName(value).split(" ").filter((token) => token.length > 1 && !ignored.has(token)));
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / Math.max(a.size, b.size);
}
