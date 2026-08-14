import { describe, expect, it } from "vitest";
import { runProcess } from "../src/process.js";

describe("runProcess", () => {
  it("returns stdout for a successful command", async () => {
    const result = await runProcess("node", ["-e", "process.stdout.write('hello')"]);
    expect(result.stdout.toString()).toBe("hello");
  });

  it("pipes input to the child", async () => {
    const result = await runProcess("node", ["-e", "process.stdin.pipe(process.stdout)"], {
      input: Buffer.from("streamed"),
    });
    expect(result.stdout.toString()).toBe("streamed");
  });

  it("survives a child that exits without reading its input", async () => {
    // Writing megabytes into a process that already exited raises EPIPE on the
    // stdin stream; an unhandled one used to take the server down.
    await expect(runProcess("node", ["-e", "process.exit(3)"], { input: Buffer.alloc(4 * 1024 * 1024, 1) }))
      .rejects.toThrow(/exited 3/);
  });

  it("reports the real cause when output exceeds the limit", async () => {
    await expect(runProcess("node", ["-e", "setInterval(() => process.stdout.write('x'.repeat(4096)), 1)"], {
      maxOutputBytes: 8_192,
      timeoutMs: 10_000,
    })).rejects.toThrow(/output limit/);
  });

  it("reports a timeout rather than an exit code", async () => {
    await expect(runProcess("node", ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 200 }))
      .rejects.toThrow(/timed out/);
  });

  it("rejects when the command does not exist", async () => {
    await expect(runProcess("autosub-does-not-exist", [])).rejects.toThrow();
  });

  it("stops the child when the caller aborts", async () => {
    const controller = new AbortController();
    const pending = runProcess("node", ["-e", "setTimeout(() => {}, 5000)"], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
  });
});
