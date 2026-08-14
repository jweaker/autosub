import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CompletedSubtitle } from "./domain.js";

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
