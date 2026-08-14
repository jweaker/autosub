import type { SubtitleCandidate, SubtitleProvider, SubtitleRequest } from "../domain.js";
import { HttpError, requestBytes, requestJson } from "../http.js";

export interface OpenSubtitlesConfig {
  apiKey?: string;
  username?: string;
  password?: string;
  userAgent: string;
  timeoutMs: number;
}

interface OpenSubtitleFile {
  file_id?: number;
  file_name?: string;
}

interface OpenSubtitleAttributes {
  language?: string;
  release?: string;
  fps?: number;
  hearing_impaired?: boolean;
  ai_translated?: boolean;
  machine_translated?: boolean;
  moviehash_match?: boolean;
  ratings?: number;
  download_count?: number;
  files?: OpenSubtitleFile[];
}

interface OpenSubtitleResult {
  id?: string;
  attributes?: OpenSubtitleAttributes;
}

const API = "https://api.opensubtitles.com/api/v1";

export class OpenSubtitlesProvider implements SubtitleProvider {
  readonly name = "opensubtitles";
  readonly enabled: boolean;
  private token?: string;
  private loginPromise?: Promise<void>;

  constructor(private readonly config: OpenSubtitlesConfig) {
    this.enabled = Boolean(config.apiKey);
  }

  private headers(includeToken = false): Record<string, string> {
    return {
      "Api-Key": this.config.apiKey || "",
      "User-Agent": this.config.userAgent,
      "Content-Type": "application/json",
      ...(includeToken && this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private queries(request: SubtitleRequest): URLSearchParams[] {
    const common = (): URLSearchParams => {
      const params = new URLSearchParams({ languages: [...request.languages].sort().join(",") });
      if (request.type === "series") {
        if (request.season) params.set("season_number", String(request.season));
        if (request.episode) params.set("episode_number", String(request.episode));
        params.set("type", "episode");
      } else params.set("type", "movie");
      return params;
    };
    const queries: URLSearchParams[] = [];
    if (request.videoHash) {
      const params = common();
      params.set("moviehash", request.videoHash);
      queries.push(params);
    }
    const metadata = common();
    if (request.imdbId) metadata.set("imdb_id", request.imdbId.replace(/^tt/, ""));
    else if (request.filename) metadata.set("query", request.filename.toLowerCase());
    queries.push(metadata);
    return queries;
  }

  async search(request: SubtitleRequest, signal: AbortSignal): Promise<SubtitleCandidate[]> {
    if (!this.enabled) return [];
    const queries = this.queries(request);
    const settled = await Promise.allSettled(queries.map((params) =>
      requestJson<{ data?: OpenSubtitleResult[] }>(`${API}/subtitles?${params}`, {
        headers: this.headers(),
        signal,
        timeoutMs: this.config.timeoutMs,
        label: "OpenSubtitles search",
      })));

    // A failing hash lookup must not discard a successful metadata lookup.
    const bodies = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    if (!bodies.length) throw settled[0].status === "rejected" ? settled[0].reason : new Error("OpenSubtitles search failed");

    const seen = new Set<number>();
    return bodies.flatMap((body) => body.data || []).flatMap((result) => {
      const attributes = result.attributes || {};
      return (attributes.files || []).flatMap((file) => {
        if (!file.file_id || !attributes.language || seen.has(file.file_id)) return [];
        seen.add(file.file_id);
        return [{
          provider: this.name,
          providerId: String(file.file_id),
          language: attributes.language.toLowerCase(),
          release: attributes.release,
          filename: file.file_name,
          format: file.file_name?.split(".").pop()?.toLowerCase(),
          fps: attributes.fps,
          hearingImpaired: attributes.hearing_impaired,
          machineTranslated: attributes.machine_translated,
          aiTranslated: attributes.ai_translated,
          hashMatch: attributes.moviehash_match,
          rating: attributes.ratings,
          downloadCount: attributes.download_count,
          locator: { fileId: file.file_id },
        } satisfies SubtitleCandidate];
      });
    });
  }

  private login(signal: AbortSignal): Promise<void> {
    if (this.token || !this.config.username || !this.config.password) return Promise.resolve();
    // One login at a time: parallel candidate downloads would otherwise each
    // spend a login call against the account's quota.
    return (this.loginPromise ??= this.performLogin(signal).finally(() => {
      this.loginPromise = undefined;
    }));
  }

  private async performLogin(signal: AbortSignal): Promise<void> {
    const body = await requestJson<{ token?: string }>(`${API}/login`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ username: this.config.username, password: this.config.password }),
      signal,
      timeoutMs: this.config.timeoutMs,
      label: "OpenSubtitles login",
    });
    if (!body.token) throw new Error("OpenSubtitles login returned no token");
    this.token = body.token;
  }

  async download(candidate: SubtitleCandidate, signal: AbortSignal): Promise<Uint8Array> {
    return this.downloadWithRetry(candidate, signal, true);
  }

  private async downloadWithRetry(candidate: SubtitleCandidate, signal: AbortSignal, canRetry: boolean): Promise<Uint8Array> {
    await this.login(signal);
    let ticket: { link?: string };
    try {
      ticket = await requestJson<{ link?: string }>(`${API}/download`, {
        method: "POST",
        headers: this.headers(true),
        body: JSON.stringify({ file_id: Number(candidate.locator.fileId) }),
        signal,
        timeoutMs: this.config.timeoutMs,
        label: "OpenSubtitles download ticket",
      });
    } catch (error) {
      // An expired session token reads as 401; log in again once.
      if (canRetry && error instanceof HttpError && error.status === 401) {
        this.token = undefined;
        return this.downloadWithRetry(candidate, signal, false);
      }
      throw error;
    }
    if (!ticket.link) throw new Error("OpenSubtitles returned no download link");
    return requestBytes(ticket.link, { signal, timeoutMs: this.config.timeoutMs, label: "OpenSubtitles file download" });
  }
}
