import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { SubtitleCue } from "../src/domain.js";
import { HttpError } from "../src/http.js";
import { createTranslator, DeepLTranslator, LibreTranslateTranslator, OpenAiCompatibleTranslator } from "../src/translation/index.js";
import { assertTranslationChanged, batchCues, runBatchResiliently, runBatches } from "../src/translation/types.js";

const cues: SubtitleCue[] = Array.from({ length: 5 }, (_, index) => ({
  id: index + 1,
  startMs: index * 2_000,
  endMs: index * 2_000 + 1_500,
  text: `line ${index + 1}`,
}));

const settings = { concurrency: 1, model: "test-model", baseUrl: "https://gateway.test/v1", apiKey: "key" };

afterEach(() => vi.unstubAllGlobals());

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

describe("choosing a backend", () => {
  const base = { INSTALL_TOKEN: "0".repeat(64), PUBLIC_URL: "https://autosub.test" };

  it("defaults to Gemini for compatibility with existing setups", () => {
    expect(createTranslator(loadConfig({ ...base, GEMINI_API_KEY: "k" })).name).toBe("gemini");
  });

  it("selects the requested provider", () => {
    expect(createTranslator(loadConfig({ ...base, TRANSLATION_PROVIDER: "openai", TRANSLATION_BASE_URL: "https://x/v1" })).name).toBe("openai");
    expect(createTranslator(loadConfig({ ...base, TRANSLATION_PROVIDER: "deepl", TRANSLATION_API_KEY: "k" })).name).toBe("deepl");
    expect(createTranslator(loadConfig({ ...base, TRANSLATION_PROVIDER: "libretranslate", TRANSLATION_BASE_URL: "https://x" })).name).toBe("libretranslate");
  });

  it("falls back to Gemini rather than failing on an unknown provider", () => {
    expect(createTranslator(loadConfig({ ...base, TRANSLATION_PROVIDER: "nonsense", GEMINI_API_KEY: "k" })).name).toBe("gemini");
  });

  it("reports whether a backend is usable", () => {
    expect(createTranslator(loadConfig({ ...base, TRANSLATION_PROVIDER: "openai" })).enabled).toBe(false);
    expect(createTranslator(loadConfig({ ...base, TRANSLATION_PROVIDER: "deepl" })).enabled).toBe(false);
  });
});

describe("OpenAI-compatible backend", () => {
  it("translates through any chat-completions endpoint", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toBe("https://gateway.test/v1/chat/completions");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer key");
      const rows = cues.map((cue) => ({ id: cue.id, text: `مترجم ${cue.id}` }));
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ cues: rows }) } }], usage: { prompt_tokens: 40, completion_tokens: 30 } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new OpenAiCompatibleTranslator(settings).translate(cues, "en", "ar");
    expect(result.map((cue) => cue.text)).toEqual(cues.map((cue) => `مترجم ${cue.id}`));
    expect(result.map((cue) => cue.startMs)).toEqual(cues.map((cue) => cue.startMs));
  });

  it("recovers JSON that a model wrapped in prose or fences", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      choices: [{ message: { content: "Sure!\n```json\n" + JSON.stringify(cues.map((cue) => ({ id: cue.id, text: `x${cue.id}` }))) + "\n```" } }],
    })));
    const result = await new OpenAiCompatibleTranslator(settings).translate(cues, "en", "ar");
    expect(result[0].text).toBe("x1");
  });

  it("refuses an answer that lost cues instead of shifting the rest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      choices: [{ message: { content: JSON.stringify([{ id: 1, text: "only one" }]) } }],
    })));
    await expect(new OpenAiCompatibleTranslator(settings).translate(cues, "en", "ar")).rejects.toThrow(/1\/5/);
  });

  it("drops optional fields for an endpoint that rejects them", async () => {
    // Strict gateways allow only model and messages and refuse the rest, which
    // should teach the client rather than fail the title.
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if ("temperature" in body || "response_format" in body) {
        return new Response(JSON.stringify({ error: { message: "Invalid or unsupported chat completion request" } }), { status: 400 });
      }
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(cues.map((cue) => ({ id: cue.id, text: `ar${cue.id}` }))) } }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const translator = new OpenAiCompatibleTranslator(settings);
    const first = await translator.translate(cues, "en", "ar");
    expect(first[0].text).toBe("ar1");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual({ model: "test-model", messages: expect.any(Array) });

    // And it stays learned, so later batches cost no extra round trip.
    bodies.length = 0;
    await translator.translate(cues, "en", "ar");
    expect(bodies).toHaveLength(1);
  });

  it("accepts a base URL that already names the endpoint", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toBe("https://gateway.test/v1/chat/completions");
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(cues.map((cue) => ({ id: cue.id, text: "t" }))) } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await new OpenAiCompatibleTranslator({ ...settings, baseUrl: "https://gateway.test/v1/chat/completions" }).translate(cues, "en", "ar");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps usage attached to the right result when titles translate concurrently", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
      const sent = JSON.parse(body.messages.at(-1)?.content.split("Cues: ")[1].split("\nRespond")[0] || "[]") as Array<{ id: number; text: string }>;
      const first = sent[0]?.text.startsWith("first");
      await new Promise((resolve) => setTimeout(resolve, first ? 15 : 1));
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(sent.map((cue) => ({ id: cue.id, text: `مترجم ${cue.id}` }))) } }],
        usage: { prompt_tokens: first ? 101 : 202, completion_tokens: first ? 11 : 22 },
      });
    }));
    const translator = new OpenAiCompatibleTranslator(settings);
    const first = cues.map((cue) => ({ ...cue, text: `first dialogue ${cue.id}` }));
    const second = cues.map((cue) => ({ ...cue, text: `second dialogue ${cue.id}` }));
    const [firstResult, secondResult] = await Promise.all([
      translator.translate(first, "en", "ar"),
      translator.translate(second, "en", "ar"),
    ]);
    expect(translator.usageFor(firstResult)?.promptTokens).toBe(101);
    expect(translator.usageFor(secondResult)?.promptTokens).toBe(202);
  });

  it("uses larger film batches to reduce fixed gateway token overhead", async () => {
    const many = Array.from({ length: 121 }, (_, index) => ({
      ...cues[0],
      id: index + 1,
      text: `source dialogue line ${index + 1}`,
    }));
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
      const sent = JSON.parse(body.messages.at(-1)?.content.split("Cues: ")[1].split("\nRespond")[0] || "[]") as Array<{ id: number }>;
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(sent.map((cue) => ({ id: cue.id, text: `مترجم ${cue.id}` }))) } }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new OpenAiCompatibleTranslator(settings).translate(many, "en", "ar");
    expect(result).toHaveLength(121);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("machine translation backends", () => {
  it("sends DeepL an array and keeps cue order", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toContain("api-free.deepl.com/v2/translate");
      const body = JSON.parse(String(init.body)) as { text: string[]; target_lang: string };
      expect(body.target_lang).toBe("AR");
      return jsonResponse({ translations: body.text.map((text) => ({ text: `[ar] ${text}` })) });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new DeepLTranslator({ apiKey: "abc:fx", concurrency: 1 }).translate(cues, "en", "ar");
    expect(result.map((cue) => cue.text)).toEqual(cues.map((cue) => `[ar] ${cue.text}`));
  });

  it("uses the paid DeepL host for a paid key", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(String(url)).toContain("https://api.deepl.com/");
      const body = JSON.parse(String(init.body)) as { text: string[] };
      return jsonResponse({ translations: body.text.map((text) => ({ text })) });
    });
    vi.stubGlobal("fetch", fetchMock);
    await new DeepLTranslator({ apiKey: "paid-key", concurrency: 1 }).translate(cues, "en", "ar");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("translates through a self-hosted LibreTranslate", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { q: string[] };
      return jsonResponse({ translatedText: body.q.map((text) => `ar:${text}`) });
    }));
    const result = await new LibreTranslateTranslator({ baseUrl: "http://vps.test:5000", concurrency: 1 }).translate(cues, "en", "ar");
    expect(result.map((cue) => cue.text)).toEqual(cues.map((cue) => `ar:${cue.text}`));
    expect(result.map((cue) => cue.endMs)).toEqual(cues.map((cue) => cue.endMs));
  });

  it("rejects a short answer rather than misaligning the rest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ translatedText: ["only one"] })));
    await expect(new LibreTranslateTranslator({ baseUrl: "http://vps.test:5000", concurrency: 1 }).translate(cues, "en", "ar"))
      .rejects.toThrow(/1\/5/);
  });

  it("reports characters so a per-character bill can be checked", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { q: string[] };
      return jsonResponse({ translatedText: body.q.map(() => "x") });
    }));
    const translator = new LibreTranslateTranslator({ baseUrl: "http://vps.test:5000", concurrency: 1 });
    await translator.translate(cues, "en", "ar");
    expect(translator.lastUsage?.characters).toBe(cues.reduce((total, cue) => total + cue.text.length, 0));
  });
});

describe("translation batching", () => {
  it("cuts near a scene pause instead of in the middle of an exchange", () => {
    const dialogue = Array.from({ length: 8 }, (_, index) => ({
      ...cues[0],
      id: index + 1,
      startMs: index < 4 ? index * 1_000 : 10_000 + (index * 1_000),
      endMs: index < 4 ? index * 1_000 + 800 : 10_800 + (index * 1_000),
      text: `line ${index}`,
    }));
    const batches = batchCues(dialogue, 6, 10_000);
    expect(batches.map((batch) => batch.map((cue) => cue.id))).toEqual([[1, 2, 3, 4], [5, 6, 7, 8]]);
  });

  it("runs independent batches at the configured concurrency", async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ ...cues[0], id: index + 1, text: `line ${index}` }));
    const batches = Array.from({ length: 6 }, (_, index) => many.slice(index * 2, index * 2 + 2));
    let active = 0;
    let maximum = 0;
    const translated = await runBatches(batches, 4, async (batch) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return new Map(batch.map((cue) => [cue.id, `ar ${cue.id}`]));
    });
    expect(maximum).toBe(4);
    expect(translated.size).toBe(12);
  });

  it("preserves completed batches and reduces concurrency after endpoint backpressure", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({ ...cues[0], id: index + 1, text: `line ${index}` }));
    const batches = many.map((cue) => [cue]);
    const reductions: number[] = [];
    let active = 0;
    let maximum = 0;
    const translated = await runBatches(batches, 4, async (batch) => {
      active += 1;
      maximum = Math.max(maximum, active);
      const accepted = active === 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (!accepted) throw new HttpError(429, "test translation", "concurrency limit");
      return new Map([[batch[0].id, `ar ${batch[0].id}`]]);
    }, { retryDelayMs: 1, onConcurrencyReduced: (value) => reductions.push(value) });

    expect(maximum).toBe(4);
    expect(reductions).toEqual([2, 1]);
    expect(translated.size).toBe(8);
  });

  it("splits only a malformed large batch instead of failing the title", async () => {
    const many = Array.from({ length: 24 }, (_, index) => ({ ...cues[0], id: index + 1 }));
    const sizes: number[] = [];
    const result = await runBatchResiliently(many, async (batch) => {
      sizes.push(batch.length);
      if (batch.length > 12) throw new Error("truncated JSON");
      return new Map(batch.map((cue) => [cue.id, `ok ${cue.id}`]));
    });
    expect(sizes).toEqual([24, 12, 12]);
    expect(result.size).toBe(24);
  });

  it("does not split a rate-limited batch into more requests", async () => {
    const many = Array.from({ length: 24 }, (_, index) => ({ ...cues[0], id: index + 1 }));
    const work = vi.fn(async () => {
      throw new HttpError(429, "test translation", "concurrency limit");
    });
    await expect(runBatchResiliently(many, work)).rejects.toThrow(/429/);
    expect(work).toHaveBeenCalledOnce();
  });

  it("refuses a model that mostly echoed the source dialogue", () => {
    const source = Array.from({ length: 20 }, (_, index) => ({ ...cues[0], id: index + 1, text: `original dialogue line ${index}` }));
    expect(() => assertTranslationChanged(source, source)).toThrow(/left 20\/20/);
  });
});
