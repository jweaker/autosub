import type { SubtitleCandidate, SubtitleProvider, SubtitleRequest } from "../domain.js";
import { requestBytes, requestJson } from "../http.js";

const LANGUAGE_NAMES: Record<string, string> = {
  ar: "arabic",
  en: "english",
  fr: "french",
  de: "german",
  es: "spanish",
  it: "italian",
  tr: "turkish",
  fa: "farsi_persian",
  ja: "japanese",
  ko: "korean",
  zh: "chinese_bg_code",
  ru: "russian",
  hi: "hindi",
  ur: "urdu",
  pt: "portuguese_brazilian",
  nl: "dutch",
  pl: "polish",
  sv: "swedish",
};

const API = "https://api.subsource.net/api/v1";

interface SubSourceMovie {
  movieId?: number;
  imdbId?: string;
  season?: number;
}

interface SubSourceSubtitle {
  subtitleId?: number;
  language?: string;
  releaseInfo?: string[] | string;
  files?: number;
  hearingImpaired?: boolean;
  framerate?: string | number | null;
  downloads?: number;
  rating?: { good?: number; bad?: number } | number;
}

export class SubSourceProvider implements SubtitleProvider {
  readonly name = "subsource";
  readonly enabled: boolean;

  constructor(private readonly apiKey?: string, private readonly timeoutMs = 8_000) {
    this.enabled = Boolean(apiKey);
  }

  private headers(): Record<string, string> {
    return { "X-API-Key": this.apiKey || "", Accept: "application/json" };
  }

  private async findMovie(request: SubtitleRequest, signal: AbortSignal): Promise<number | undefined> {
    if (!request.imdbId) return undefined;
    const params = new URLSearchParams({ searchType: "imdb", imdb: request.imdbId });
    if (request.season) params.set("season", String(request.season));
    const body = await requestJson<{ data?: SubSourceMovie[] }>(`${API}/movies/search?${params}`, {
      headers: this.headers(),
      signal,
      timeoutMs: this.timeoutMs,
      label: "SubSource movie search",
    });
    const exact = (body.data || []).find((movie) => movie.imdbId === request.imdbId && (!request.season || movie.season === request.season));
    return exact?.movieId || body.data?.[0]?.movieId;
  }

  private async searchLanguage(
    request: SubtitleRequest,
    language: string,
    movieId: number | undefined,
    signal: AbortSignal,
  ): Promise<SubtitleCandidate[]> {
    const params = new URLSearchParams({
      language: LANGUAGE_NAMES[language] || language,
      sort: "rating",
      limit: "100",
    });
    if (movieId) params.set("movieId", String(movieId));
    if (request.filename) params.set("releaseInfo", request.filename);
    const body = await requestJson<{ data?: SubSourceSubtitle[] }>(`${API}/subtitles?${params}`, {
      headers: this.headers(),
      signal,
      timeoutMs: this.timeoutMs,
      label: "SubSource subtitle search",
    });

    return (body.data || []).flatMap((subtitle) => {
      if (!subtitle.subtitleId) return [];
      const rating = typeof subtitle.rating === "number"
        ? subtitle.rating
        : (subtitle.rating?.good || 0) - (subtitle.rating?.bad || 0);
      const fps = subtitle.framerate == null ? undefined : Number(subtitle.framerate);
      return [{
        provider: this.name,
        providerId: String(subtitle.subtitleId),
        language,
        release: Array.isArray(subtitle.releaseInfo) ? subtitle.releaseInfo.join(" ") : subtitle.releaseInfo,
        filename: `subsource-${subtitle.subtitleId}.zip`,
        format: "zip",
        fps: Number.isFinite(fps) ? fps : undefined,
        hearingImpaired: subtitle.hearingImpaired,
        rating,
        downloadCount: subtitle.downloads,
        locator: { subtitleId: subtitle.subtitleId, episode: request.episode },
      } satisfies SubtitleCandidate];
    });
  }

  async search(request: SubtitleRequest, signal: AbortSignal): Promise<SubtitleCandidate[]> {
    if (!this.apiKey) return [];
    const movieId = await this.findMovie(request, signal);
    if (!movieId && !request.filename) return [];
    // Languages are independent lookups; running them together keeps a
    // multi-language search as fast as a single-language one.
    const settled = await Promise.allSettled(
      request.languages.map((language) => this.searchLanguage(request, language, movieId, signal)),
    );
    const candidates = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    if (!candidates.length) {
      const failure = settled.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
    return candidates;
  }

  async download(candidate: SubtitleCandidate, signal: AbortSignal): Promise<Uint8Array> {
    const id = Number(candidate.locator.subtitleId);
    if (!Number.isInteger(id) || id <= 0) throw new Error("Invalid SubSource subtitle ID");
    return requestBytes(`${API}/subtitles/${id}/download`, {
      headers: this.headers(),
      signal,
      timeoutMs: this.timeoutMs,
      label: "SubSource file download",
    });
  }
}
