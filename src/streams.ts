import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StreamRecord, SubtitleRequest } from "./domain.js";

export interface UpstreamStream {
  url?: string;
  name?: string;
  title?: string;
  behaviorHints?: {
    filename?: string;
    videoHash?: string;
    videoSize?: number;
    proxyHeaders?: { request?: Record<string, string> };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface RegistryData {
  records: StreamRecord[];
  selected: Record<string, string>;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_RECORDS = 4_000;
const REFRESH_INTERVAL_MS = 60_000;

/**
 * Remembers which concrete release a `/play` link points at.
 *
 * Stremio asks for subtitles without telling us which stream the user picked,
 * so the play redirect is the only moment that identity is known. Records are
 * keyed by the upstream URL, which makes repeated stream listings for the same
 * title reuse their play links instead of growing the registry every refresh.
 */
export class StreamRegistry {
  private readonly records = new Map<string, StreamRecord>();
  private readonly byUrl = new Map<string, string>();
  private readonly selected = new Map<string, string>();
  private readonly waiters = new Set<() => void>();
  private loading?: Promise<void>;
  private writing = Promise.resolve();
  private dirty = false;

  constructor(
    private readonly storagePath: string,
    private readonly publicUrl: string,
    private readonly installToken: string,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  private key(type: string, contentId: string): string {
    return `${type}:${contentId}`;
  }

  private urlKey(type: string, contentId: string, url: string): string {
    return `${type}:${contentId}:${url}`;
  }

  load(): Promise<void> {
    // Callers race on startup and on the first request; they must all wait for
    // the same read rather than proceeding against an empty registry.
    return (this.loading ??= this.read());
  }

  private async read(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.storagePath, "utf8")) as RegistryData;
      const now = Date.now();
      for (const record of parsed.records || []) {
        if (now - record.discoveredAt >= this.ttlMs) continue;
        this.records.set(record.playId, record);
        this.byUrl.set(this.urlKey(record.type, record.contentId, record.url), record.playId);
      }
      for (const [key, playId] of Object.entries(parsed.selected || {})) {
        if (this.records.has(playId)) this.selected.set(key, playId);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Could not load stream registry:", error);
    }
  }

  /** Serializes writes; concurrent callers share one flush of the latest state. */
  private persist(): Promise<void> {
    if (!this.dirty) return this.writing;
    this.writing = this.writing.then(() => this.flush()).catch((error) => {
      console.warn("Could not persist stream registry:", error instanceof Error ? error.message : error);
    });
    return this.writing;
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await mkdir(dirname(this.storagePath), { recursive: true });
    const temporary = `${this.storagePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const body: RegistryData = { records: [...this.records.values()], selected: Object.fromEntries(this.selected) };
    await writeFile(temporary, JSON.stringify(body), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.storagePath);
  }

  private forget(playId: string): void {
    const record = this.records.get(playId);
    if (!record) return;
    this.records.delete(playId);
    const urlKey = this.urlKey(record.type, record.contentId, record.url);
    if (this.byUrl.get(urlKey) === playId) this.byUrl.delete(urlKey);
    for (const [key, selectedId] of this.selected) if (selectedId === playId) this.selected.delete(key);
    this.dirty = true;
  }

  private prune(): void {
    const now = Date.now();
    for (const [playId, record] of this.records) {
      if (now - record.discoveredAt >= this.ttlMs) this.forget(playId);
    }
    // Insertion order is discovery order, so the oldest surplus goes first.
    let surplus = this.records.size - MAX_RECORDS;
    if (surplus <= 0) return;
    for (const playId of this.records.keys()) {
      if (surplus-- <= 0) break;
      this.forget(playId);
    }
  }

  /** Drops expired records; safe to call on a timer. */
  async sweep(): Promise<void> {
    await this.load();
    this.prune();
    await this.persist();
  }

  async wrap(type: string, contentId: string, streams: UpstreamStream[]): Promise<UpstreamStream[]> {
    await this.load();
    this.prune();
    const now = Date.now();
    const wrapped = streams.flatMap((stream) => {
      // This installation is deliberately debrid-only: never hand a torrent
      // infoHash through to a Stremio client when the upstream has no HTTP URL.
      if (!stream.url || !/^https?:\/\//i.test(stream.url)) return [];
      const urlKey = this.urlKey(type, contentId, stream.url);
      const existingId = this.byUrl.get(urlKey);
      const existing = existingId ? this.records.get(existingId) : undefined;
      if (existing) {
        // Refresh lazily: a client that re-lists a title every few seconds
        // should not rewrite the registry file each time.
        if (now - existing.discoveredAt > REFRESH_INTERVAL_MS) {
          existing.discoveredAt = now;
          existing.filename = stream.behaviorHints?.filename ?? existing.filename;
          existing.videoHash = stream.behaviorHints?.videoHash ?? existing.videoHash;
          existing.videoSize = stream.behaviorHints?.videoSize ?? existing.videoSize;
          existing.requestHeaders = stream.behaviorHints?.proxyHeaders?.request ?? existing.requestHeaders;
          this.dirty = true;
        }
        return [{ ...stream, url: this.playUrl(existing.playId) }];
      }
      const playId = randomBytes(18).toString("base64url");
      this.records.set(playId, {
        playId,
        type,
        contentId,
        url: stream.url,
        filename: stream.behaviorHints?.filename,
        videoHash: stream.behaviorHints?.videoHash,
        videoSize: stream.behaviorHints?.videoSize,
        requestHeaders: stream.behaviorHints?.proxyHeaders?.request,
        discoveredAt: now,
      });
      this.byUrl.set(urlKey, playId);
      this.dirty = true;
      return [{ ...stream, url: this.playUrl(playId) }];
    });
    await this.persist();
    return wrapped;
  }

  private playUrl(playId: string): string {
    return `${this.publicUrl}/${this.installToken}/play/${playId}`;
  }

  async select(playId: string): Promise<StreamRecord | undefined> {
    await this.load();
    const record = this.records.get(playId);
    if (!record || Date.now() - record.discoveredAt >= this.ttlMs) return undefined;
    this.selected.set(this.key(record.type, record.contentId), playId);
    this.dirty = true;
    // Wake any subtitle request already waiting for this title's release.
    for (const waiter of this.waiters) waiter();
    await this.persist();
    return record;
  }

  async find(request: SubtitleRequest): Promise<StreamRecord | undefined> {
    await this.load();
    const selectedId = this.selected.get(this.key(request.type, request.contentId));
    const selected = selectedId ? this.records.get(selectedId) : undefined;
    if (selected && Date.now() - selected.discoveredAt < this.ttlMs) return selected;
    const records = [...this.records.values()].filter((record) =>
      record.type === request.type
      && record.contentId === request.contentId
      && Date.now() - record.discoveredAt < this.ttlMs);
    if (request.videoHash) {
      const match = records.find((record) => record.videoHash === request.videoHash);
      if (match) return match;
    }
    if (request.filename) {
      const match = records.find((record) => record.filename === request.filename);
      if (match) return match;
    }
    if (request.videoSize) {
      const match = records.find((record) => record.videoSize === request.videoSize);
      if (match) return match;
    }
    return records.length === 1 ? records[0] : undefined;
  }

  /**
   * Waits for the play redirect that identifies the release. Stremio often asks
   * for subtitles a moment before it opens the stream, so this resolves on the
   * selection itself instead of polling the clock away.
   */
  async waitFor(request: SubtitleRequest, timeoutMs = 12_000): Promise<StreamRecord | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const record = await this.find(request);
      if (record) return record;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await new Promise<void>((resolve) => {
        const waiter = (): void => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve();
        };
        const timer = setTimeout(waiter, Math.min(remaining, 1_000));
        this.waiters.add(waiter);
      });
    }
  }
}

export class UpstreamStreamAddon {
  private readonly baseUrl?: string;

  constructor(manifestUrl: string | undefined, private readonly registry: StreamRegistry) {
    this.baseUrl = manifestUrl?.replace(/\/manifest\.json$/i, "").replace(/\/$/, "");
  }

  get enabled(): boolean {
    return Boolean(this.baseUrl);
  }

  async streams(type: string, contentId: string, signal: AbortSignal): Promise<{ streams: UpstreamStream[] }> {
    if (!this.baseUrl) return { streams: [] };
    const response = await fetch(`${this.baseUrl}/stream/${encodeURIComponent(type)}/${encodeURIComponent(contentId)}.json`, { signal });
    if (!response.ok) throw new Error(`Upstream stream addon failed: ${response.status}`);
    const body = (await response.json()) as { streams?: UpstreamStream[] };
    const streams = Array.isArray(body.streams) ? body.streams : [];
    return { streams: await this.registry.wrap(type, contentId, streams) };
  }
}
