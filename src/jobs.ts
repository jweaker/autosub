import { PreparationError } from "./errors.js";
import { randomBytes } from "node:crypto";
import type { CompletedSubtitle, StreamRecord, SubtitleRequest } from "./domain.js";
import type { AutoSubPipeline } from "./pipeline.js";

interface Job {
  id: string;
  key: string;
  request: SubtitleRequest;
  stream: StreamRecord;
  language: string;
  promise: Promise<CompletedSubtitle>;
  createdAt: number;
  state: "queued" | "preparing" | "ready" | "failed";
  cacheKey?: string;
  controller: AbortController;
  run: () => void;
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
 * Runs one subtitle preparation per release and language, and lets any number
 * of requests await the same result.
 *
 * Stremio asks for the subtitle list and then fetches the file, often more than
 * once and from more than one device, so deduplicating by release is what keeps
 * a single expensive pipeline run from becoming several.
 */
export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly byKey = new Map<string, string>();
  private readonly queue: Job[] = [];
  private stopping = false;

  constructor(
    private readonly pipeline: AutoSubPipeline,
    private readonly retentionMs = DEFAULT_RETENTION_MS,
    private readonly concurrency = 2,
    private readonly timeoutMs = 600_000,
  ) {}

  get size(): number {
    return this.jobs.size;
  }

  get running(): number {
    let count = 0;
    for (const job of this.jobs.values()) if (job.state === "preparing") count += 1;
    return count;
  }

  start(request: SubtitleRequest, stream: StreamRecord, language: string): string {
    this.prune();
    const key = this.pipeline.releaseKey(request, stream, language);
    const existing = this.byKey.get(key);
    if (existing && this.jobs.has(existing)) return existing;
    if (this.stopping || this.queue.length >= 8) throw new PreparationError("busy", "Subtitle preparation is busy; retry shortly");

    const id = randomBytes(16).toString("base64url");
    const controller = new AbortController();
    let resolve!: (result: CompletedSubtitle) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<CompletedSubtitle>((yes, no) => { resolve = yes; reject = no; });
    const job: Job = {
      id, key, request, stream, language, promise, controller,
      createdAt: Date.now(),
      state: "queued",
      run: () => {
        job.state = "preparing";
        const timer = setTimeout(() => controller.abort(new PreparationError("deadline", "Subtitle preparation exceeded its time budget")), this.timeoutMs);
        void this.pipeline.complete(request, stream, language, controller.signal).then((result) => {
          controller.signal.throwIfAborted();
          job.cacheKey = result.key;
          resolve(result);
        }).catch(reject).finally(() => clearTimeout(timer));
      },
    };
    this.jobs.set(id, job);
    this.byKey.set(key, id);
    this.queue.push(job);
    void promise.then(
      () => { job.state = "ready"; this.pump(); },
      () => {
        job.state = "failed";
        if (this.byKey.get(key) === id) this.byKey.delete(key);
        this.pump();
      },
    );
    this.pump();
    return id;
  }

  get queued(): number { return this.queue.length; }

  private pump(): void {
    while (this.queue.length && this.running < this.concurrency) this.queue.shift()!.run();
  }

  /** Disk cache deletion also forgets completed in-memory results. */
  invalidate(keys: string[]): void {
    const removed = new Set(keys);
    for (const [id, job] of this.jobs) {
      if (job.state !== "ready" || !job.cacheKey || !removed.has(job.cacheKey)) continue;
      this.jobs.delete(id);
      if (this.byKey.get(job.key) === id) this.byKey.delete(job.key);
    }
  }

  shutdown(): void {
    this.stopping = true;
    for (const job of this.jobs.values()) {
      if (job.state === "queued" || job.state === "preparing") {
        job.controller.abort(new PreparationError("unavailable", "Server is restarting; reopen the title shortly"));
      }
    }
  }

  /** Target language of a job, used to phrase status messages. */
  languageOf(id: string): string | undefined {
    return this.jobs.get(id)?.language;
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

  prune(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, job] of this.jobs) {
      if (job.createdAt >= cutoff || (job.state === "preparing" || job.state === "queued")) continue;
      this.jobs.delete(id);
      if (this.byKey.get(job.key) === id) this.byKey.delete(job.key);
    }
  }
}
