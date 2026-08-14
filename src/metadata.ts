import type { MediaType } from "./domain.js";
import { requestJson } from "./http.js";
import { normalizeLanguage } from "./languages.js";

interface FindResponse {
  movie_results?: Array<{ original_language?: string }>;
  tv_results?: Array<{ original_language?: string }>;
}

/**
 * TMDB's original-language field, used to choose the audio track and the
 * source-language subtitle search. It is a hint only: a mislabelled release is
 * still caught by transcription-based language detection.
 */
export class MetadataService {
  private readonly cache = new Map<string, string | undefined>();

  constructor(private readonly tmdbToken?: string, private readonly timeoutMs = 8_000) {}

  async originalLanguage(imdbId: string | undefined, type: MediaType): Promise<string | undefined> {
    if (!this.tmdbToken || !imdbId) return undefined;
    const key = `${type}:${imdbId}`;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.cache.size > 500) this.cache.clear();
    try {
      const url = new URL(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}`);
      url.searchParams.set("external_source", "imdb_id");
      const body = await requestJson<FindResponse>(url, {
        headers: { Authorization: `Bearer ${this.tmdbToken}`, Accept: "application/json" },
        timeoutMs: this.timeoutMs,
        label: "TMDB find",
      });
      const raw = type === "series" ? body.tv_results?.[0]?.original_language : body.movie_results?.[0]?.original_language;
      const language = normalizeLanguage(raw);
      this.cache.set(key, language);
      return language;
    } catch (error) {
      // Metadata is advisory; a failure must not stop subtitle preparation.
      console.warn("TMDB lookup failed:", error instanceof Error ? error.message : error);
      return undefined;
    }
  }
}
