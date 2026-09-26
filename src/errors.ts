/** Stable failure categories for HTTP responses and operator diagnostics. */
export class PreparationError extends Error {
  constructor(readonly code: "no-match" | "unavailable" | "deadline" | "busy", message: string) {
    super(message);
    this.name = "PreparationError";
  }
}

/** Provider and media errors can contain signed URLs or authorization headers. */
export function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted URL]")
    .replace(/\b(authorization|api[-_]?key|token|password)\s*[:=]\s*[^\r\n,;]+/gi, "$1=[redacted]");
}
