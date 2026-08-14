import type { MediaType, SubtitleRequest } from "./domain.js";

export function parseSubtitleRequest(
  typeValue: string,
  idValue: string,
  extraValue: string | undefined,
  languages: string[],
): SubtitleRequest {
  const type: MediaType = typeValue === "series" ? "series" : "movie";
  const safelyDecode = (value: string): string => {
    try { return decodeURIComponent(value); } catch { return value; }
  };
  const decodedId = safelyDecode(idValue);
  const idParts = decodedId.split(":");
  const extra = new URLSearchParams(extraValue ? safelyDecode(extraValue) : "");
  const videoSize = Number.parseInt(extra.get("videoSize") || "", 10);

  return {
    type,
    contentId: decodedId,
    imdbId: idParts[0].startsWith("tt") ? idParts[0] : undefined,
    season: type === "series" && idParts[1] ? Number.parseInt(idParts[1], 10) : undefined,
    episode: type === "series" && idParts[2] ? Number.parseInt(idParts[2], 10) : undefined,
    videoHash: extra.get("videoHash") || undefined,
    videoSize: Number.isFinite(videoSize) ? videoSize : undefined,
    filename: extra.get("filename") || undefined,
    languages,
  };
}
