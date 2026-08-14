import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, isTransient, request, requestJson } from "../src/http.js";

afterEach(() => vi.unstubAllGlobals());

const respond = (status: number, body = "{}"): Response => new Response(body, { status });

describe("outbound requests", () => {
  it("returns the parsed body of a successful call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(200, JSON.stringify({ ok: true }))));
    expect(await requestJson<{ ok: boolean }>("https://example.test/x")).toEqual({ ok: true });
  });

  it("retries a transient status and succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(respond(503))
      .mockResolvedValueOnce(respond(200, JSON.stringify({ ok: 1 })));
    vi.stubGlobal("fetch", fetchMock);
    expect(await requestJson("https://example.test/x", { label: "Test" })).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a client error", async () => {
    const fetchMock = vi.fn(async () => respond(404, "missing"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(request("https://example.test/x", { label: "Test" })).rejects.toThrow(/Test failed: 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured number of attempts", async () => {
    const fetchMock = vi.fn(async () => respond(502));
    vi.stubGlobal("fetch", fetchMock);
    await expect(request("https://example.test/x", { attempts: 3, label: "Test" })).rejects.toThrow(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("honours a Retry-After header instead of failing immediately", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(respond(200));
    vi.stubGlobal("fetch", fetchMock);
    expect((await request("https://example.test/x")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not immediately retry a quota with a long Retry-After", async () => {
    const fetchMock = vi.fn(async () => new Response("daily quota exhausted", {
      status: 429,
      headers: { "retry-after": "14400" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(request("https://example.test/x", { label: "Provider" })).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 14_400_000,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("stops immediately when the caller aborts", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(request("https://example.test/x", { signal: controller.signal })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies network faults as transient", () => {
    expect(isTransient(new TypeError("fetch failed"))).toBe(true);
    expect(isTransient(new HttpError(503, "Test"))).toBe(true);
    expect(isTransient(new HttpError(404, "Test"))).toBe(false);
    expect(isTransient(new Error("bad subtitle"))).toBe(false);
  });
});
