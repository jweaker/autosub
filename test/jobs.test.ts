import { describe, expect, it, vi } from "vitest";
import type { CompletedSubtitle, StreamRecord, SubtitleRequest } from "../src/domain.js";
import { JobExpiredError, JobManager, JobTimeoutError } from "../src/jobs.js";
import type { AutoSubPipeline } from "../src/pipeline.js";

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
  language: "ar",
  content: "1\n00:00:01,000 --> 00:00:02,000\nx\n",
  confidence: 80,
  provider,
  translated: false,
});

const pipelineOf = (complete: AutoSubPipeline["complete"]): AutoSubPipeline => ({ complete } as AutoSubPipeline);

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

  it("drops finished jobs once they age out", async () => {
    const jobs = new JobManager(pipelineOf(vi.fn(async () => completed("subdl"))), 5);
    const id = jobs.start(request, stream, "ar");
    await jobs.result(id, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Starting anything prunes settled jobs that are past the retention window.
    jobs.start({ ...request, contentId: "tt2" }, stream, "ar");
    expect(jobs.size).toBe(1);
    await expect(jobs.result(id, 100)).rejects.toBeInstanceOf(JobExpiredError);
  });
});
