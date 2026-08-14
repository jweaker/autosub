const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 10_000;
// Short rate-limit windows are worth respecting; daily/hourly quota exhaustion
// is surfaced immediately and handled by the pipeline's provider cooldown.
const MAX_RETRY_DELAY_MS = 30_000;

export interface RequestOptions extends Omit<RequestInit, "signal"> {
  /** Per-attempt deadline. Each retry gets a fresh one. */
  timeoutMs?: number;
  /** Total attempts, including the first. */
  attempts?: number;
  /** Caller-owned cancellation, typically a pipeline-wide budget. */
  signal?: AbortSignal;
  /** Label used in error messages, e.g. "OpenSubtitles search". */
  label?: string;
}

export class HttpError extends Error {
  constructor(readonly status: number, label: string, detail?: string, readonly retryAfterMs?: number) {
    super(`${label} failed: ${status}${detail ? ` ${detail}` : ""}`);
    this.name = "HttpError";
  }

  get retryable(): boolean {
    return RETRYABLE_STATUS.has(this.status);
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error("Aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Transient network faults look the same from fetch as a 503 does. */
export function isTransient(error: unknown): boolean {
  if (error instanceof HttpError) return error.retryable;
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /AbortError|TimeoutError|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|socket hang up|timed?\s*out|\b(408|425|429|500|502|503|504)\b/i.test(message);
}

/** Honours Retry-After when the server sends it, otherwise exponential backoff with jitter. */
function backoffMs(attempt: number, response?: Response): number {
  const requested = response ? retryAfterMs(response) : undefined;
  if (requested !== undefined) return Math.min(MAX_RETRY_DELAY_MS, requested);
  const base = Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 250);
}

/**
 * A single place where every outbound call gets a timeout, bounded retries and
 * consistent error text. Provider APIs rate-limit and time out often enough
 * that retrying them individually used to be reimplemented per call site.
 */
export async function request(url: string | URL, options: RequestOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, attempts = 2, signal, label, ...init } = options;
  const name = label || new URL(url).host;
  let lastError: unknown;

  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(url, { ...init, signal: combined });
      if (response.ok) return response;
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      const requestedDelay = retryAfterMs(response);
      const error = new HttpError(response.status, name, detail, requestedDelay);
      if (attempt >= attempts || !error.retryable) throw error;
      // A provider saying "come back in four hours" is an exhausted quota, not
      // a transient worth repeating four seconds later. Retrying only burns a
      // second request and delays every remaining candidate from that provider.
      if (requestedDelay !== undefined && requestedDelay > MAX_RETRY_DELAY_MS) throw error;
      lastError = error;
      await delay(backoffMs(attempt, response), signal);
    } catch (error) {
      if (error instanceof HttpError && !error.retryable) throw error;
      if (error instanceof HttpError && (error.retryAfterMs || 0) > MAX_RETRY_DELAY_MS) throw error;
      // The caller's own cancellation is final; only our per-attempt timeout retries.
      if (signal?.aborted) throw error;
      if (attempt >= attempts || !isTransient(error)) throw error;
      lastError = error;
      await delay(backoffMs(attempt), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${name} failed`);
}

export async function requestJson<T>(url: string | URL, options: RequestOptions = {}): Promise<T> {
  const response = await request(url, options);
  return (await response.json()) as T;
}

export async function requestBytes(url: string | URL, options: RequestOptions = {}): Promise<Uint8Array> {
  const response = await request(url, options);
  return new Uint8Array(await response.arrayBuffer());
}
