import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompletedSubtitle } from "./domain.js";

export interface CachedSubtitleInfo {
  key: string;
  id: string;
  contentId?: string;
  release?: string;
  language: string;
  provider: string;
  confidence: number;
  translated: boolean;
  sourceLanguage?: string;
  cachedAt: string;
  bytes: number;
}

export function stableKey(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Finished subtitles on disk, keyed by release fingerprint.
 *
 * A hit skips audio analysis, provider searches, and translation entirely, so
 * this is the difference between a 30-second and an instant second play.
 */
export class SubtitleCache {
  private readonly root: string;
  private ready?: Promise<void>;

  constructor(dataDir: string) {
    this.root = join(dataDir, "subtitles");
  }

  private paths(key: string): { subtitle: string; metadata: string } {
    return { subtitle: join(this.root, `${key}.srt`), metadata: join(this.root, `${key}.json`) };
  }

  private directory(): Promise<void> {
    return (this.ready ??= mkdir(this.root, { recursive: true }).then(() => undefined));
  }

  async get(key: string): Promise<CompletedSubtitle | undefined> {
    const paths = this.paths(key);
    try {
      const [content, metadata] = await Promise.all([readFile(paths.subtitle, "utf8"), readFile(paths.metadata, "utf8")]);
      return { ...(JSON.parse(metadata) as Omit<CompletedSubtitle, "content">), content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Subtitle cache read failed:", error);
      return undefined;
    }
  }

  async put(result: CompletedSubtitle): Promise<void> {
    const paths = this.paths(result.key);
    await this.directory();
    // A unique suffix keeps two jobs writing the same key from sharing a
    // temporary file and producing a truncated entry.
    const suffix = `${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const temporary = { subtitle: `${paths.subtitle}.${suffix}`, metadata: `${paths.metadata}.${suffix}` };
    try {
      await Promise.all([
        writeFile(temporary.subtitle, result.content, { encoding: "utf8", mode: 0o600 }),
        writeFile(temporary.metadata, JSON.stringify({ ...result, content: undefined }), { encoding: "utf8", mode: 0o600 }),
      ]);
      await Promise.all([rename(temporary.subtitle, paths.subtitle), rename(temporary.metadata, paths.metadata)]);
    } catch (error) {
      await Promise.all([rm(temporary.subtitle, { force: true }), rm(temporary.metadata, { force: true })]);
      throw error;
    }
  }

  /** Metadata-only inventory for the authenticated operator dashboard. */
  async list(): Promise<CachedSubtitleInfo[]> {
    try {
      const names = await readdir(this.root);
      const entries = await Promise.all(names
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map(async (name): Promise<CachedSubtitleInfo | undefined> => {
          const key = name.slice(0, -5);
          const paths = this.paths(key);
          try {
            const [raw, metadataInfo, subtitleInfo] = await Promise.all([
              readFile(paths.metadata, "utf8"),
              stat(paths.metadata),
              stat(paths.subtitle),
            ]);
            const metadata = JSON.parse(raw) as Omit<CompletedSubtitle, "content">;
            return {
              key,
              id: metadata.id,
              contentId: metadata.contentId,
              release: metadata.release,
              language: metadata.language,
              provider: metadata.provider,
              confidence: metadata.confidence,
              translated: metadata.translated,
              sourceLanguage: metadata.sourceLanguage,
              cachedAt: metadata.cachedAt || metadataInfo.mtime.toISOString(),
              bytes: metadataInfo.size + subtitleInfo.size,
            };
          } catch {
            // Ignore half-written, corrupt, or concurrently removed entries.
            return undefined;
          }
        }));
      return entries
        .filter((entry): entry is CachedSubtitleInfo => Boolean(entry))
        .sort((left, right) => Date.parse(right.cachedAt) - Date.parse(left.cachedAt));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Subtitle cache listing failed:", error);
      return [];
    }
  }

  /** Removes only explicit, validated cache keys. */
  async removeMany(keys: string[]): Promise<number> {
    const unique = [...new Set(keys)].filter((key) => /^[a-f0-9]{64}$/.test(key)).slice(0, 200);
    let removed = 0;
    await Promise.all(unique.map(async (key) => {
      const paths = this.paths(key);
      const existing = await Promise.allSettled([stat(paths.subtitle), stat(paths.metadata)]);
      if (existing.some((item) => item.status === "fulfilled")) removed += 1;
      await Promise.all([rm(paths.subtitle, { force: true }), rm(paths.metadata, { force: true })]);
    }));
    return removed;
  }

  /** Drops entries older than `maxAgeMs` so the data volume cannot grow without bound. */
  async sweep(maxAgeMs: number): Promise<number> {
    if (maxAgeMs <= 0) return 0;
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    try {
      const names = await readdir(this.root);
      await Promise.all(names.map(async (name) => {
        const path = join(this.root, name);
        try {
          const info = await stat(path);
          if (info.mtimeMs >= cutoff) return;
          await rm(path, { force: true });
          if (name.endsWith(".srt")) removed += 1;
        } catch {
          // A concurrent write or removal raced us; the next sweep will retry.
        }
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Subtitle cache sweep failed:", error);
    }
    return removed;
  }
}
