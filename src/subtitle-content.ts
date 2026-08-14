import { detect } from "chardet";
import { unzipSync } from "fflate";
import iconv from "iconv-lite";
import type { SubtitleCandidate } from "./domain.js";
import { normalizeLanguage } from "./languages.js";

const MAX_DOWNLOAD_BYTES = 15 * 1024 * 1024;
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;
const SUPPORTED = /\.(?:srt|vtt|ass|ssa)$/i;
// Archive noise that looks like a subtitle but never is: macOS resource forks
// and their container directory decode to binary garbage.
const JUNK = /(?:^|\/)(?:__MACOSX\/|\._)/;
const SAMPLE = /\b(?:sample|trailer|preview)\b/i;

function chooseArchiveFile(files: Record<string, Uint8Array>, candidate: SubtitleCandidate): [string, Uint8Array] {
  let entries = Object.entries(files)
    .filter(([name, bytes]) => SUPPORTED.test(name) && !JUNK.test(name) && bytes.length <= MAX_SUBTITLE_BYTES);
  if (!entries.length) throw new Error("Subtitle archive contains no supported text subtitle");
  const episode = Number(candidate.locator.episode);
  if (Number.isFinite(episode)) {
    const marker = new RegExp(`(?:s\\d{1,3}e|e|episode[ ._-]*)0?${episode}(?:\\D|$)`, "i");
    const matches = entries.filter(([name]) => marker.test(name));
    if (matches.length) entries = matches;
  }
  const language = normalizeLanguage(candidate.language);
  const aliases: Record<string, string[]> = {
    ar: ["ar", "ara", "arabic", "العربية"],
    en: ["en", "eng", "english"],
    ja: ["ja", "jpn", "japanese"],
    fr: ["fr", "fra", "fre", "french"],
    es: ["es", "spa", "spanish"],
  };
  const markers = language ? (aliases[language] || [language]) : [];
  const languageMatches = markers.length ? entries.filter(([name]) => markers.some((marker) => (
    new RegExp(`(?:^|[^\\p{L}\\p{N}])${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^\\p{L}\\p{N}])`, "iu").test(name)
  ))) : [];
  if (languageMatches.length) entries = languageMatches;
  // Season packs and multi-language archives list files in arbitrary order, so
  // prefer the fullest non-sample track rather than whichever comes first.
  const preferred = entries.filter(([name]) => !SAMPLE.test(name));
  return (preferred.length ? preferred : entries).reduce((best, entry) => (entry[1].length > best[1].length ? entry : best));
}

function unpack(bytes: Uint8Array, candidate: SubtitleCandidate): { name: string; bytes: Uint8Array } {
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error("Subtitle download exceeds safety limit");
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = unzipSync(bytes, {
      filter: (file) => SUPPORTED.test(file.name) && !JUNK.test(file.name) && file.originalSize <= MAX_SUBTITLE_BYTES,
    });
    const [name, extracted] = chooseArchiveFile(files, candidate);
    return { name, bytes: extracted };
  }
  return { name: candidate.filename || `subtitle.${candidate.format || "srt"}`, bytes };
}

const ENCODING_ALIASES: Record<string, string> = {
  "ISO-8859-6": "iso-8859-6",
  "windows-1256": "windows-1256",
  "UTF-8": "utf8",
  "UTF-16LE": "utf16-le",
};

function decodeAs(bytes: Uint8Array, encoding: string): string | undefined {
  try {
    return iconv.decode(Buffer.from(bytes), ENCODING_ALIASES[encoding] || encoding.toLowerCase());
  } catch {
    return undefined;
  }
}

const damage = (text: string): number => (text.match(/�/g)?.length || 0) / Math.max(1, text.length);

function decodingScore(text: string, language?: string): number {
  let score = damage(text);
  if (normalizeLanguage(language) === "ar") {
    const letters = text.match(/\p{L}/gu)?.length || 0;
    const arabic = text.match(/\p{Script=Arabic}/gu)?.length || 0;
    // Timings and indices dominate the file, so even a real Arabic subtitle may
    // have a modest whole-file ratio. The penalty only breaks otherwise
    // damage-free ties between a Latin mojibake decode and windows-1256.
    if (letters >= 10) score += (1 - (arabic / letters)) * 0.25;
  }
  return score;
}

/**
 * Subtitle files ship in whatever encoding their author used, and Arabic ones
 * are frequently windows-1256 mislabelled as UTF-8. Detection is tried first,
 * then legacy code pages, keeping whichever decodes with the least damage.
 */
function decode(bytes: Uint8Array, language?: string): string {
  const detected = detect(bytes) || "UTF-8";
  let best = decodeAs(bytes, detected) ?? iconv.decode(Buffer.from(bytes), "utf8");
  let bestDamage = decodingScore(best, language);
  for (const fallback of ["windows-1256", "windows-1252", "iso-8859-6", "utf8"]) {
    if (fallback === detected) continue;
    const candidate = decodeAs(bytes, fallback);
    const candidateDamage = candidate === undefined ? 1 : decodingScore(candidate, language);
    if (candidate !== undefined && candidateDamage < bestDamage) {
      best = candidate;
      bestDamage = candidateDamage;
    }
  }
  return best;
}

function assTimeToSrt(value: string): string {
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})[.:](\d{2,3})$/);
  if (!match) return value;
  return `${match[1].padStart(2, "0")}:${match[2]}:${match[3]},${match[4].padEnd(3, "0")}`;
}

function assToSrt(input: string): string {
  const lines = input.split(/\r?\n/);
  let format: string[] = [];
  const cues: string[] = [];
  for (const line of lines) {
    if (/^Format:/i.test(line)) format = line.slice(line.indexOf(":") + 1).split(",").map((value) => value.trim().toLowerCase());
    if (!/^Dialogue:/i.test(line) || !format.length) continue;
    const values = line.slice(line.indexOf(":") + 1).split(",");
    if (values.length > format.length) values.splice(format.length - 1, values.length - format.length + 1, values.slice(format.length - 1).join(","));
    const row = Object.fromEntries(format.map((key, index) => [key, values[index] || ""]));
    const text = row.text.replace(/\{[^}]*\}/g, "").replace(/\\[Nn]/g, "\n").replace(/\\h/g, " ").trim();
    if (text) cues.push(`${cues.length + 1}\n${assTimeToSrt(row.start)} --> ${assTimeToSrt(row.end)}\n${text}`);
  }
  if (!cues.length) throw new Error("ASS subtitle contains no dialogue cues");
  return `${cues.join("\n\n")}\n`;
}

function vttToSrt(input: string): string {
  const blocks = input.replace(/^\uFEFF?WEBVTT[^\n]*\n+/i, "").split(/\n{2,}/);
  const cues: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].replace(/(\d{2}:\d{2}:\d{2})\.(\d{3})/g, "$1,$2").replace(/\s+(?:align|position|size|line):\S+/g, "");
    const text = lines.slice(timingIndex + 1).join("\n").trim();
    if (text) cues.push(`${cues.length + 1}\n${timing}\n${text}`);
  }
  if (!cues.length) throw new Error("WebVTT subtitle contains no cues");
  return `${cues.join("\n\n")}\n`;
}

export function prepareSubtitle(raw: Uint8Array, candidate: SubtitleCandidate): string {
  const file = unpack(raw, candidate);
  const text = decode(file.bytes, candidate.language).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (/\.(?:ass|ssa)$/i.test(file.name) || /^\[Script Info\]/im.test(text)) return assToSrt(text);
  if (/\.vtt$/i.test(file.name) || /^WEBVTT/i.test(text)) return vttToSrt(text);
  if (!/\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/m.test(text)) throw new Error("Downloaded file is not a valid timed subtitle");
  return `${text}\n`;
}
