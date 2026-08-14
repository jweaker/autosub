import { randomBytes } from "node:crypto";
import type { CompletedSubtitle, StreamRecord, SubtitleRequest } from "./domain.js";
import type { AutoSubPipeline } from "./pipeline.js";
import type { RejectionStore } from "./rejections.js";

interface Job {
  id: string;
  key: string;
  releaseKey: string;
  request: SubtitleRequest;
  stream: StreamRecord;
  language: string;
  promise: Promise<CompletedSubtitle>;
  createdAt: number;
  state: "preparing" | "ready" | "failed";
  result?: CompletedSubtitle;
  error?: unknown;
}

export type JobSnapshot =
  | { state: "preparing" }
  | { state: "ready"; result: CompletedSubtitle }
  | { state: "failed"; error: unknown };

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
 * Runs one subtitle preparation per release, language and rejection set, and
 * lets any number of requests await the same result.
 *
 * Stremio asks for the subtitle list and then fetches the file, often more than
 * once and from more than one device, so deduplicating by release is what keeps
 * a single expensive pipeline run from becoming several.
 */
export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private readonly byKey = new Map<string, string>();
  /** Latest job per release, so a stale URL still reaches the current attempt. */
  private readonly byRelease = new Map<string, string>();

  constructor(
    private readonly pipeline: AutoSubPipeline,
    private readonly rejections?: RejectionStore,
    private readonly retentionMs = DEFAULT_RETENTION_MS,
  ) {}

  get size(): number {
    return this.jobs.size;
  }

  get running(): number {
    let count = 0;
    for (const job of this.jobs.values()) if (job.state === "preparing") count += 1;
    return count;
  }

  start(request: SubtitleRequest, stream: StreamRecord, language: string, exclude: string[] = [], translate = false): string {
    const releaseKey = this.pipeline.releaseKey(request, stream, language);
    // A translation request is a different question from the same release, so
    // it gets its own job rather than reusing the one that already gave up.
    const key = `${releaseKey}:${[...exclude].sort().join(",")}${translate ? ":translate" : ""}`;
    const existing = this.byKey.get(key);
    if (existing && this.jobs.has(existing)) return existing;

    const id = randomBytes(16).toString("base64url");
    const job: Job = {
      id,
      key,
      releaseKey,
      request,
      stream,
      language,
      promise: this.pipeline.complete(request, stream, language, exclude, translate),
      createdAt: Date.now(),
      state: "preparing",
    };
    this.jobs.set(id, job);
    this.byKey.set(key, id);
    this.byRelease.set(releaseKey, id);
    void job.promise.then(
      (result) => {
        job.state = "ready";
        job.result = result;
      },
      (error: unknown) => {
        job.state = "failed";
        job.error = error;
        // Keep the failed job so the in-flight file request sees the real
        // error, but let the next playback retry instead of pinning the
        // failure for the whole retention window.
        if (this.byKey.get(key) === id) this.byKey.delete(key);
      },
    );
    this.prune();
    return id;
  }

  /** Starts a job that already skips everything the viewer rejected before. */
  async startTracked(request: SubtitleRequest, stream: StreamRecord, language: string, translate = false): Promise<string> {
    const releaseKey = this.pipeline.releaseKey(request, stream, language);
    const exclude = this.rejections ? await this.rejections.list(releaseKey) : [];
    return this.start(request, stream, language, exclude, translate);
  }

  /**
   * Prepares an AI translation for the release a job belongs to, which the
   * viewer has to ask for explicitly when translation is not automatic.
   */
  async translate(id: string, timeoutMs: number): Promise<CompletedSubtitle> {
    const job = this.current(id);
    if (!job) throw new JobExpiredError();
    const translationId = await this.startTracked(job.request, job.stream, job.language, true);
    return this.result(translationId, timeoutMs);
  }

  /** Target language of a job, used to phrase status messages. */
  languageOf(id: string): string | undefined {
    return this.current(id)?.language;
  }

  /** The newest attempt for the release a job belongs to. */
  private current(id: string): Job | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const latest = this.byRelease.get(job.releaseKey);
    return (latest && this.jobs.get(latest)) || job;
  }

  async result(id: string, timeoutMs: number): Promise<CompletedSubtitle> {
    const job = this.current(id);
    if (!job) throw new JobExpiredError();
    return this.waitForResult(job, timeoutMs);
  }

  private async waitForResult(job: Job, timeoutMs: number): Promise<CompletedSubtitle> {
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

  /**
   * State of a job for labelling purposes, waiting briefly so that a cache hit
   * is reported as ready rather than as still preparing.
   */
  async snapshot(id: string, waitMs = 0): Promise<JobSnapshot | undefined> {
    const job = this.current(id);
    if (!job) return undefined;
    if (job.state === "preparing" && waitMs > 0) {
      await Promise.race([job.promise.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, waitMs))]);
    }
    if (job.state === "ready" && job.result) return { state: "ready", result: job.result };
    if (job.state === "failed") return { state: "failed", error: job.error };
    return { state: "preparing" };
  }

  /**
   * Marks the release's current subtitle as rejected and prepares the next
   * best one. Returns undefined when nothing else passed validation.
   */
  async retry(id: string, timeoutMs: number): Promise<CompletedSubtitle | undefined> {
    const job = this.current(id);
    if (!job) throw new JobExpiredError();
    const snapshot = await this.snapshot(job.id, timeoutMs);
    if (!snapshot || snapshot.state !== "ready") {
      // Nothing was delivered yet, so there is nothing to reject; the caller
      // reports the original outcome instead.
      if (snapshot?.state === "failed") return undefined;
      throw new JobTimeoutError(timeoutMs);
    }

    const exclude = this.rejections
      ? await this.rejections.add(job.releaseKey, snapshot.result.id)
      : [snapshot.result.id];
    console.log(`Rejected ${snapshot.result.id} for ${job.request.contentId} (${job.language}); trying the next candidate`);
    const nextId = this.start(job.request, job.stream, job.language, exclude);
    try {
      return await this.result(nextId, timeoutMs);
    } catch (error) {
      if (error instanceof JobTimeoutError) throw error;
      return undefined;
    }
  }

  /** Rejections recorded for the release a job belongs to. */
  async rejectedFor(id: string): Promise<string[]> {
    const job = this.jobs.get(id);
    if (!job || !this.rejections) return [];
    return this.rejections.list(job.releaseKey);
  }

  private prune(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const [id, job] of this.jobs) {
      if (job.createdAt >= cutoff || job.state === "preparing") continue;
      this.jobs.delete(id);
      if (this.byKey.get(job.key) === id) this.byKey.delete(job.key);
      if (this.byRelease.get(job.releaseKey) === id) this.byRelease.delete(job.releaseKey);
    }
  }
}
