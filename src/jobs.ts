import { randomBytes } from "node:crypto";
import type { CompletedSubtitle, StreamRecord, SubtitleRequest } from "./domain.js";
import type { AutoSubPipeline } from "./pipeline.js";

interface Job {
  key: string;
  promise: Promise<CompletedSubtitle>;
  createdAt: number;
  settled: boolean;
}

const DEFAULT_RETENTION_MS = 6 * 60 * 60 * 1000;

export class JobExpiredError extends Error {
  constructor() {
    super("Subtitle job expired; reopen the video to retry");
    this.name = "JobExpiredError";
  }
}

export class JobTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Subtitle preparation did not finish within ${Math.round(timeoutMs / 1000)}s; it continues in the background`);
    this.name = "JobTimeoutError";
  }
}

/**
 * Runs one subtitle preparation per release/language and lets any number of
 * requests await the same result.
 *
 * Stremio asks for the subtitle list and then fetches the file, often more than
 * once and from more than one device, so deduplicating by release is what keeps
 * a single expensive pipeline run from becoming several.
 */
export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly byKey = new Map<string, string>();

  constructor(private readonly pipeline: AutoSubPipeline, private readonly retentionMs = DEFAULT_RETENTION_MS) {}

  get size(): number {
    return this.jobs.size;
  }

  get running(): number {
    let count = 0;
    for (const job of this.jobs.values()) if (!job.settled) count += 1;
    return count;
  }

  start(request: SubtitleRequest, stream: StreamRecord, language: string): string {
    const key = `${request.type}:${request.contentId}:${stream.videoHash || stream.filename || stream.playId}:${language}`;
    const existing = this.byKey.get(key);
    if (existing && this.jobs.has(existing)) return existing;
    const id = randomBytes(16).toString("base64url");
    const promise = this.pipeline.complete(request, stream, language);
    const job: Job = { key, promise, createdAt: Date.now(), settled: false };
    this.jobs.set(id, job);
    this.byKey.set(key, id);
    void promise.then(
      () => {
        job.settled = true;
      },
      () => {
        job.settled = true;
        // Keep the failed job so the in-flight file request sees the real
        // error, but let the next playback retry instead of pinning the
        // failure for the whole retention window.
        if (this.byKey.get(key) === id) this.byKey.delete(key);
      },
    );
    this.prune();
    return id;
  }

  async result(id: string, timeoutMs: number): Promise<CompletedSubtitle> {
    const job = this.jobs.get(id);
    if (!job) throw new JobExpiredError();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        job.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new JobTimeoutError(timeoutMs)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private prune(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, job] of this.jobs) {
      if (job.createdAt >= cutoff || !job.settled) continue;
      this.jobs.delete(id);
      if (this.byKey.get(job.key) === id) this.byKey.delete(job.key);
    }
  }
}
