const TWO_TO_THREE: Record<string, string> = {
  ar: "ara", en: "eng", fr: "fra", de: "deu", es: "spa", it: "ita",
  ja: "jpn", ko: "kor", zh: "zho", tr: "tur", fa: "fas", ru: "rus",
  hi: "hin", ur: "urd", pt: "por", nl: "nld", pl: "pol", sv: "swe",
};

const THREE_TO_TWO = Object.fromEntries(Object.entries(TWO_TO_THREE).map(([two, three]) => [three, two]));
Object.assign(THREE_TO_TWO, { fre: "fr", ger: "de", chi: "zh", per: "fa", dut: "nl" });

export function normalizeLanguage(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().split(/[-_]/)[0];
  if (["und", "unk", "unknown", "mul", "zxx"].includes(normalized)) return undefined;
  if (normalized.length === 2) return normalized;
  return THREE_TO_TWO[normalized] || normalized;
}

export function stremioLanguage(value: string): string {
  const normalized = normalizeLanguage(value) || value;
  return TWO_TO_THREE[normalized] || normalized;
}

export function languageName(value: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(normalizeLanguage(value) || value) || value;
  } catch {
    return value;
  }
}
