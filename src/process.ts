import { spawn } from "node:child_process";

export interface ProcessResult {
  stdout: Buffer;
  stderr: string;
}

export interface ProcessOptions {
  input?: Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Aborting kills the child and rejects with the abort reason. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_LIMIT = 32 * 1024 * 1024;

/**
 * Runs a child process to completion, buffering stdout with a hard ceiling.
 *
 * Every failure mode settles exactly once: a timeout, an output overrun, an
 * abort, a spawn error, or a non-zero exit. Writing the input is deliberately
 * fault-tolerant because a child that exits early (ffmpeg rejecting a stream,
 * a missing Python module) closes stdin under us, and an unhandled EPIPE there
 * would take the whole server down.
 */
export function runProcess(command: string, args: string[], options: ProcessOptions = {}): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limit = options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT;

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`${command} was aborted before it started`));
      return;
    }

    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let failure: Error | undefined;
    let timer: NodeJS.Timeout | undefined;

    const settle = (error: Error | undefined, result?: ProcessResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result as ProcessResult);
    };

    // Record why we are killing the child so `close` can report the real cause
    // instead of a bare "exited null".
    const stop = (error: Error): void => {
      failure ??= error;
      child.kill("SIGKILL");
    };

    function onAbort(): void {
      stop(new Error(`${command} was aborted`));
    }

    timer = setTimeout(() => stop(new Error(`${command} timed out after ${timeoutMs} ms`)), timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > limit) stop(new Error(`${command} exceeded the ${limit} byte output limit`));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.stdin.on("error", () => undefined);
    child.on("error", (error) => settle(error));
    child.on("close", (code) => {
      const errorText = Buffer.concat(stderr).toString("utf8");
      if (failure) settle(failure);
      else if (code !== 0) settle(new Error(`${command} exited ${code}: ${errorText.slice(-800)}`));
      else settle(undefined, { stdout: Buffer.concat(stdout), stderr: errorText });
    });

    child.stdin.end(options.input);
  });
}
