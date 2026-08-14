import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubtitleCandidate } from "../src/domain.js";
import { SubDlProvider } from "../src/providers/subdl.js";

const candidate = (url: string): SubtitleCandidate => ({
  provider: "subdl",
  providerId: "1",
  language: "ar",
  locator: { url },
});

afterEach(() => vi.unstubAllGlobals());

describe("SubDL downloads", () => {
  it("accepts both documented subtitle and provider mobile download paths", async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new SubDlProvider("key");
    await provider.download(candidate("/subtitle/package/file"), new AbortController().signal);
    await provider.download(candidate("/mobile/package"), new AbortController().signal);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects absolute URLs outside SubDL's pinned download origin", async () => {
    const provider = new SubDlProvider("key");
    await expect(provider.download(candidate("https://example.com/subtitle/file"), new AbortController().signal))
      .rejects.toThrow("invalid download path");
  });
});
