import { describe, expect, it } from "vitest";
import { configWarnings, INSECURE_TOKEN, loadConfig } from "../src/config.js";

const base = { INSTALL_TOKEN: "0".repeat(64), PUBLIC_URL: "https://autosub.test", UPSTREAM_ADDON_URL: "https://upstream.test/manifest.json" };

describe("configuration", () => {
  it("applies documented defaults", () => {
    const config = loadConfig({ ...base });
    expect(config).toMatchObject({ port: 7000, defaultLanguages: ["ar"], minimumConfidence: 58, candidateLimit: 10 });
    expect(config.translation.concurrency).toBe(12);
    expect(config.gemini.concurrency).toBe(12);
  });

  it("trims trailing slashes from URLs", () => {
    expect(loadConfig({ ...base, PUBLIC_URL: "https://autosub.test///" }).publicUrl).toBe("https://autosub.test");
  });

  it("parses and normalizes language lists", () => {
    const config = loadConfig({ ...base, DEFAULT_LANGUAGES: " AR , En ,", REFERENCE_LANGUAGES: "EN" });
    expect(config.defaultLanguages).toEqual(["ar", "en"]);
    expect(config.referenceLanguages).toEqual(["en"]);
  });

  it("clamps out-of-range numbers instead of trusting them", () => {
    const config = loadConfig({ ...base, MINIMUM_CONFIDENCE: "900", CANDIDATE_LIMIT: "0", AUDIO_SAMPLE_COUNT: "99" });
    expect(config.minimumConfidence).toBe(100);
    expect(config.candidateLimit).toBe(1);
    expect(config.audioSampleCount).toBe(12);
  });

  it("falls back when a value is not a number", () => {
    expect(loadConfig({ ...base, PORT: "not-a-port" }).port).toBe(7000);
  });

  it("warns about an unset install token and missing upstream", () => {
    const warnings = configWarnings(loadConfig({}));
    expect(warnings.join(" ")).toContain("INSTALL_TOKEN");
    expect(warnings.join(" ")).toContain("UPSTREAM_ADDON_URL");
    expect(loadConfig({}).installToken).toBe(INSECURE_TOKEN);
  });

  it("stays quiet about the token once it is long and random", () => {
    const warnings = configWarnings(loadConfig({ ...base, GEMINI_API_KEY: "k", DEEPGRAM_API_KEY: "k" }));
    expect(warnings).toEqual([]);
  });
});
