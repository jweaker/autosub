import type { SubtitleCandidate, SubtitleProvider, SubtitleRequest } from "../domain.js";
import { requestBytes, requestJson } from "../http.js";

interface SubDlFile {
  file_n_id?: string;
  name?: string;
  release_name?: string;
  language?: string;
  format?: string;
  url?: string;
  hi?: boolean;
}

interface SubDlSubtitle {
  n_id?: string;
  name?: string;
  release_name?: string;
  language?: string;
  url?: string;
  fps?: string | number | null;
  hi?: boolean;
  unpack_files?: SubDlFile[];
}

const DOWNLOAD_ORIGIN = "https://dl.subdl.com";
const DOWNLOAD_PATHS = ["/subtitle/", "/mobile/"];

export class SubDlProvider implements SubtitleProvider {
  readonly name = "subdl";
  readonly enabled: boolean;

  constructor(private readonly apiKey?: string, private readonly timeoutMs = 8_000) {
    this.enabled = Boolean(apiKey);
  }

  async search(request: SubtitleRequest, signal: AbortSignal): Promise<SubtitleCandidate[]> {
    if (!this.apiKey) return [];
    const params = new URLSearchParams({
      api_key: this.apiKey,
      type: request.type === "series" ? "tv" : "movie",
      languages: request.languages.map((language) => language.toUpperCase()).join(","),
      releases: "1",
      unpack: "1",
      client: "stremio",
      subs_per_page: "30",
    });
    if (request.imdbId) params.set("imdb_id", request.imdbId);
    if (request.filename) params.set("file_name", request.filename);
    if (request.season) params.set("season_number", String(request.season));
    if (request.episode) params.set("episode_number", String(request.episode));

    const body = await requestJson<{ status?: boolean; subtitles?: SubDlSubtitle[] }>(
      `https://api.subdl.com/api/v1/subtitles?${params}`,
      { signal, timeoutMs: this.timeoutMs, label: "SubDL search" },
    );
    if (!body.status) return [];

    return (body.subtitles || []).flatMap((subtitle, subtitleIndex) => {
      const files = subtitle.unpack_files?.length ? subtitle.unpack_files : [{
        file_n_id: subtitle.n_id || String(subtitleIndex),
        name: subtitle.name,
        release_name: subtitle.release_name,
        language: subtitle.language,
        url: subtitle.url,
        hi: subtitle.hi,
      }];

      return files.flatMap((file) => {
        if (!file.url || !(file.language || subtitle.language)) return [];
        const rawFps = subtitle.fps == null ? undefined : Number(subtitle.fps);
        return [{
          provider: this.name,
          providerId: file.file_n_id || subtitle.n_id || `${subtitleIndex}`,
          language: (file.language || subtitle.language || "").toLowerCase(),
          release: file.release_name || subtitle.release_name,
          filename: file.name || subtitle.name,
          format: file.format || file.name?.split(".").pop()?.toLowerCase(),
          fps: Number.isFinite(rawFps) ? rawFps : undefined,
          hearingImpaired: file.hi ?? subtitle.hi,
          locator: { url: file.url },
        } satisfies SubtitleCandidate];
      });
    });
  }

  async download(candidate: SubtitleCandidate, signal: AbortSignal): Promise<Uint8Array> {
    const url = new URL(String(candidate.locator.url || ""), DOWNLOAD_ORIGIN);
    // SubDL currently returns both /subtitle/... and /mobile/... downloads.
    // Pin the origin and allowed paths so accepting either form cannot become
    // an SSRF/open-redirect vector if a provider response is compromised.
    if (url.origin !== DOWNLOAD_ORIGIN || !DOWNLOAD_PATHS.some((prefix) => url.pathname.startsWith(prefix))) {
      throw new Error("SubDL returned an invalid download path");
    }
    if (this.apiKey) url.searchParams.set("api_key", this.apiKey);
    return requestBytes(url, {
      signal,
      timeoutMs: this.timeoutMs,
      label: "SubDL file download",
      headers: this.apiKey ? { "x-api-key": this.apiKey } : undefined,
    });
  }
}
