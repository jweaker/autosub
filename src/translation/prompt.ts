import type { SubtitleCue } from "../domain.js";
import { languageName } from "../languages.js";

/**
 * The instruction both language-model backends share.
 *
 * Cues carry ids so a reordered or partial answer can be detected rather than
 * silently shifting every line onto the wrong timestamp.
 */
export function translationPrompt(batch: SubtitleCue[], source: string, target: string): string {
  return [
    `Translate subtitle dialogue from ${languageName(source)} to ${languageName(target)}.`,
    "Return a JSON array where every cue appears exactly once with its unchanged numeric id.",
    "Translate naturally for on-screen subtitles, using concise lines.",
    "Preserve speaker dashes, basic HTML/italics tags, names, intentional line breaks, and bracketed sound descriptions. Do not add commentary.",
    `Cues: ${JSON.stringify(batch.map(({ id, text }) => ({ id, text })))}`,
  ].join("\n");
}

export interface TranslationRow {
  id: number;
  text: string;
}

/** Models sometimes wrap JSON in prose or code fences; recover the array. */
export function parseRows(text: string): TranslationRow[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  const body = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  const parsed = JSON.parse(body) as unknown;
  if (Array.isArray(parsed)) return parsed as TranslationRow[];
  const rows = (parsed as { cues?: TranslationRow[]; translations?: TranslationRow[] });
  return rows.cues || rows.translations || [];
}

/** Keeps only rows that belong to this batch, so a bad answer fails loudly. */
export function collectRows(batch: SubtitleCue[], rows: TranslationRow[]): Map<number, string> {
  const expected = new Set(batch.map((cue) => cue.id));
  const output = new Map<number, string>();
  for (const row of rows) {
    if (!expected.has(row.id) || typeof row.text !== "string" || !row.text.trim() || output.has(row.id)) continue;
    output.set(row.id, row.text.trim());
  }
  if (output.size !== batch.length) throw new Error(`Model returned ${output.size}/${batch.length} valid cue translations`);
  return output;
}
