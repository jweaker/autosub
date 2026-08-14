import { afterEach, describe, expect, it, vi } from "vitest";
import { SubSourceProvider } from "../src/providers/subsource.js";

afterEach(() => vi.unstubAllGlobals());

describe("SubSource search", () => {
  it("does not over-constrain an exact IMDb match with the full release filename", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes("/movies/search")) {
        return new Response(JSON.stringify({ data: [{ movieId: 42, imdbId: "tt13186482" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ subtitleId: 7, releaseInfo: ["BluRay REMUX"] }] }), { status: 200 });
    }));

    const results = await new SubSourceProvider("key").search({
      type: "movie",
      contentId: "tt13186482",
      imdbId: "tt13186482",
      filename: "MUFASA.THE.LION.KING.2024.2160p.UHD.BDRemux.mkv",
      languages: ["ar"],
    }, new AbortController().signal);

    expect(results).toHaveLength(1);
    const subtitleUrl = new URL(urls.find((url) => url.includes("/subtitles?")) as string);
    expect(subtitleUrl.searchParams.get("movieId")).toBe("42");
    expect(subtitleUrl.searchParams.has("releaseInfo")).toBe(false);
  });

  it("keeps the best matching release name instead of diluting it with the whole list", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes("/movies/search")) {
        return new Response(JSON.stringify({ data: [{ movieId: 42, imdbId: "tt1" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{
        subtitleId: 7,
        releaseInfo: ["Movie.2024.WEB-DL-OTHER", "Movie.2024.2160p.BluRay.REMUX-GROUP"],
      }] }), { status: 200 });
    }));
    const results = await new SubSourceProvider("key").search({
      type: "movie",
      contentId: "tt1",
      imdbId: "tt1",
      filename: "Movie.2024.2160p.BluRay.REMUX-GROUP.mkv",
      languages: ["ar"],
    }, new AbortController().signal);
    expect(results[0].release).toBe("Movie.2024.2160p.BluRay.REMUX-GROUP");
  });
});
