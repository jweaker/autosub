import { describe, expect, it } from "vitest";
import { languageName, normalizeLanguage, stremioLanguage } from "../src/languages.js";

describe("language codes", () => {
  it("normalizes two- and three-letter forms to one code", () => {
    expect(normalizeLanguage("ARA")).toBe("ar");
    expect(normalizeLanguage("ar")).toBe("ar");
    expect(normalizeLanguage("pt-BR")).toBe("pt");
    expect(normalizeLanguage("zh_Hans")).toBe("zh");
  });

  it("accepts the bibliographic codes containers use", () => {
    expect(normalizeLanguage("fre")).toBe("fr");
    expect(normalizeLanguage("ger")).toBe("de");
    expect(normalizeLanguage("per")).toBe("fa");
  });

  it("treats undefined markers as unknown", () => {
    for (const value of ["und", "unk", "unknown", "mul", "zxx", undefined, ""]) {
      expect(normalizeLanguage(value)).toBeUndefined();
    }
  });

  it("emits the three-letter code Stremio expects", () => {
    expect(stremioLanguage("ar")).toBe("ara");
    expect(stremioLanguage("ARA")).toBe("ara");
    expect(stremioLanguage("xx")).toBe("xx");
  });

  it("renders a human-readable name for prompts", () => {
    expect(languageName("ar")).toBe("Arabic");
    expect(languageName("eng")).toBe("English");
  });
});
