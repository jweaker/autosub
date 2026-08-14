import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const MAX_RELEASES = 500;
const MAX_PER_RELEASE = 20;

/**
 * Remembers which subtitle variants the viewer rejected, per release.
 *
 * "Try another" would be pointless if the next play handed back the same file,
 * so the list survives restarts and is fed back into the pipeline as an
 * exclusion set.
 */
export class RejectionStore {
  private readonly path: string;
  private readonly rejected = new Map<string, string[]>();
  private loading?: Promise<void>;
  private writing = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, "rejections.json");
  }

  load(): Promise<void> {
    return (this.loading ??= this.read());
  }

  private async read(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Record<string, string[]>;
      for (const [key, ids] of Object.entries(parsed)) {
        if (Array.isArray(ids)) this.rejected.set(key, ids.filter((id) => typeof id === "string"));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn("Could not load rejections:", error);
    }
  }

  async list(releaseKey: string): Promise<string[]> {
    await this.load();
    return [...(this.rejected.get(releaseKey) || [])];
  }

  async add(releaseKey: string, variantId: string): Promise<string[]> {
    await this.load();
    const existing = this.rejected.get(releaseKey) || [];
    if (!existing.includes(variantId)) existing.push(variantId);
    // Re-inserting moves this release to the end of the map, so eviction below
    // drops the least recently touched titles first.
    this.rejected.delete(releaseKey);
    this.rejected.set(releaseKey, existing.slice(-MAX_PER_RELEASE));
    while (this.rejected.size > MAX_RELEASES) {
      const oldest = this.rejected.keys().next();
      if (oldest.done) break;
      this.rejected.delete(oldest.value);
    }
    await this.persist();
    return this.list(releaseKey);
  }

  private persist(): Promise<void> {
    this.writing = this.writing.then(() => this.flush()).catch((error) => {
      console.warn("Could not persist rejections:", error instanceof Error ? error.message : error);
    });
    return this.writing;
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, JSON.stringify(Object.fromEntries(this.rejected)), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.path);
  }
}
