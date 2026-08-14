import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CompletedSubtitle, StreamRecord, SubtitleRequest } from "../src/domain.js";
import { JobExpiredError, JobManager, JobTimeoutError } from "../src/jobs.js";
import type { AutoSubPipeline } from "../src/pipeline.js";
import { RejectionStore } from "../src/rejections.js";

const request: SubtitleRequest = { type: "movie", contentId: "tt1", languages: ["ar"] };
const stream: StreamRecord = {
  playId: "play",
  type: "movie",
  contentId: "tt1",
  url: "https://d.example/a.mkv",
  filename: "A.mkv",
  discoveredAt: Date.now(),
};

const completed = (provider: string): CompletedSubtitle => ({
  key: "k",
  id: `${provider}:1`,
  language: "ar",
  content: "1\n00:00:01,000 --> 00:00:02,000\nx\n",
  confidence: 80,
  provider,
  translated: false,
});

const pipelineOf = (complete: AutoSubPipeline["complete"]): AutoSubPipeline => ({
  complete,
  releaseKey: (request: SubtitleRequest, _stream: StreamRecord, language: string) => `${request.type}:${request.contentId}:${language}`,
} as AutoSubPipeline);

describe("job manager", () => {
  it("runs one pipeline per release and language", async () => {
    const complete = vi.fn(async () => completed("opensubtitles"));
    const jobs = new JobManager(pipelineOf(complete));
    const first = jobs.start(request, stream, "ar");
    const second = jobs.start(request, stream, "ar");
    expect(second).toBe(first);
    expect(jobs.start(request, stream, "en")).not.toBe(first);
    expect(complete).toHaveBeenCalledTimes(2);
    expect((await jobs.result(first, 1_000)).provider).toBe("opensubtitles");
  });

  it("serves the same result to every waiter", async () => {
    const jobs = new JobManager(pipelineOf(vi.fn(async () => completed("subdl"))));
    const id = jobs.start(request, stream, "ar");
    const [left, right] = await Promise.all([jobs.result(id, 1_000), jobs.result(id, 1_000)]);
    expect(left).toBe(right);
  });

  it("keeps a forced AI result separate from the normal subtitle chain", async () => {
    const complete = vi.fn(async (_request, _stream, _language, _exclude: string[] = [], translate = false) => ({
      ...completed(translate ? "opensubtitles+openai" : "opensubtitles"),
      translated: translate,
    }));
    const jobs = new JobManager(pipelineOf(complete as unknown as AutoSubPipeline["complete"]));
    const directId = jobs.start(request, stream, "ar");
    expect((await jobs.result(directId, 1_000)).translated).toBe(false);

    const translated = await jobs.translate(directId, 1_000);
    expect(translated.translated).toBe(true);
    expect(complete).toHaveBeenLastCalledWith(request, stream, "ar", [], true);
    // Selecting the paid alternative must not replace the normal row.
    expect((await jobs.result(directId, 1_000)).translated).toBe(false);
  });

  it("reports an unknown job as expired", async () => {
    const jobs = new JobManager(pipelineOf(vi.fn(async () => completed("subdl"))));
    await expect(jobs.result("missing", 100)).rejects.toBeInstanceOf(JobExpiredError);
  });

  it("times out slow preparation without cancelling it", async () => {
    let finish: (value: CompletedSubtitle) => void = () => undefined;
    const jobs = new JobManager(pipelineOf(vi.fn(() => new Promise<CompletedSubtitle>((resolve) => {
      finish = resolve;
    }))));
    const id = jobs.start(request, stream, "ar");
    await expect(jobs.result(id, 50)).rejects.toBeInstanceOf(JobTimeoutError);
    finish(completed("subsource"));
    // The background run keeps going, so a retry gets the finished subtitle.
    expect((await jobs.result(id, 1_000)).provider).toBe("subsource");
  });

  it("lets the next playback retry after a failure", async () => {
    const complete = vi.fn()
      .mockRejectedValueOnce(new Error("no match"))
      .mockResolvedValueOnce(completed("subdl"));
    const jobs = new JobManager(pipelineOf(complete as unknown as AutoSubPipeline["complete"]));
    const failing = jobs.start(request, stream, "ar");
    await expect(jobs.result(failing, 1_000)).rejects.toThrow("no match");

    const retry = jobs.start(request, stream, "ar");
    expect(retry).not.toBe(failing);
    expect((await jobs.result(retry, 1_000)).provider).toBe("subdl");
  });

  it("rejects the delivered subtitle and prepares the next one", async () => {
    const complete = vi.fn(async (_request, _stream, _language, exclude: string[] = []) =>
      (exclude.length ? completed("subdl") : completed("opensubtitles")));
    const store = new RejectionStore(await mkdtemp(join(tmpdir(), "autosub-jobs-")));
    const jobs = new JobManager(pipelineOf(complete as unknown as AutoSubPipeline["complete"]), store);

    const id = jobs.start(request, stream, "ar");
    expect((await jobs.result(id, 1_000)).provider).toBe("opensubtitles");

    const next = await jobs.retry(id, 1_000);
    expect(next?.provider).toBe("subdl");
    // The rejection is remembered, and the original URL now follows the chain.
    expect(await store.list("movie:tt1:ar")).toEqual(["opensubtitles:1"]);
    expect((await jobs.result(id, 1_000)).provider).toBe("subdl");
  });

  it("also rejects duplicate content published under another provider id", async () => {
    const result = { ...completed("opensubtitles"), contentHash: "same-timeline" };
    const complete = vi.fn(async () => result);
    const store = new RejectionStore(await mkdtemp(join(tmpdir(), "autosub-jobs-")));
    const jobs = new JobManager(pipelineOf(complete), store);
    const id = jobs.start(request, stream, "ar");
    await jobs.result(id, 1_000);
    await jobs.retry(id, 1_000);
    expect(await store.list("movie:tt1:ar")).toEqual(["opensubtitles:1", "content:same-timeline"]);
  });

  it("starts new jobs already skipping past rejections", async () => {
    const complete = vi.fn(async (_request, _stream, _language, exclude: string[] = []) =>
      (exclude.length ? completed("subdl") : completed("opensubtitles")));
    const store = new RejectionStore(await mkdtemp(join(tmpdir(), "autosub-jobs-")));
    await store.add("movie:tt1:ar", "opensubtitles:1");
    const jobs = new JobManager(pipelineOf(complete as unknown as AutoSubPipeline["complete"]), store);

    const id = await jobs.startTracked(request, stream, "ar");
    expect((await jobs.result(id, 1_000)).provider).toBe("subdl");
  });

  it("reports that nothing else is available", async () => {
    const complete = vi.fn(async (_request, _stream, _language, exclude: string[] = []) => {
      if (exclude.length) throw new Error("nothing left");
      return completed("subdl");
    });
    const jobs = new JobManager(pipelineOf(complete as unknown as AutoSubPipeline["complete"]));
    const id = jobs.start(request, stream, "ar");
    await jobs.result(id, 1_000);
    expect(await jobs.retry(id, 1_000)).toBeUndefined();
  });

  it("describes job state for the subtitle menu", async () => {
    let finish: (value: CompletedSubtitle) => void = () => undefined;
    const jobs = new JobManager(pipelineOf(vi.fn(() => new Promise<CompletedSubtitle>((resolve) => {
      finish = resolve;
    }))));
    const id = jobs.start(request, stream, "ar");
    expect((await jobs.snapshot(id, 10))?.state).toBe("preparing");
    finish(completed("subdl"));
    const ready = await jobs.snapshot(id, 100);
    expect(ready?.state).toBe("ready");
    expect(ready?.state === "ready" && ready.result.provider).toBe("subdl");
    expect(jobs.languageOf(id)).toBe("ar");
  });

  it("drops finished jobs once they age out", async () => {
    const jobs = new JobManager(pipelineOf(vi.fn(async () => completed("subdl"))), undefined, 5);
    const id = jobs.start(request, stream, "ar");
    await jobs.result(id, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Starting anything prunes settled jobs that are past the retention window.
    jobs.start({ ...request, contentId: "tt2" }, stream, "ar");
    expect(jobs.size).toBe(1);
    await expect(jobs.result(id, 100)).rejects.toBeInstanceOf(JobExpiredError);
  });
});
