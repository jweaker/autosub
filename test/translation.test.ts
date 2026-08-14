import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { SubtitleCue } from "../src/domain.js";
import { createTranslator, DeepLTranslator, LibreTranslateTranslator, OpenAiCompatibleTranslator } from "../src/translation/index.js";

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

  it("accepts a base URL that already names the endpoint", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toBe("https://gateway.test/v1/chat/completions");
      return jsonResponse({ choices: [{ message: { content: JSON.stringify(cues.map((cue) => ({ id: cue.id, text: "t" }))) } }] });
    });
    vi.stubGlobal("fetch", fetchMock);
    await new OpenAiCompatibleTranslator({ ...settings, baseUrl: "https://gateway.test/v1/chat/completions" }).translate(cues, "en", "ar");
    expect(fetchMock).toHaveBeenCalledOnce();
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
