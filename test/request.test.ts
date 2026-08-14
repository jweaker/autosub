import { describe, expect, it } from "vitest";
import { parseSubtitleRequest } from "../src/request.js";

describe("Stremio subtitle request", () => {
  it("parses an episode and stream hints", () => {
    const request = parseSubtitleRequest("series", "tt1234567:2:8", "videoHash=abc&videoSize=42&filename=Show.S02E08.mkv", ["ar"]);
    expect(request).toMatchObject({ imdbId: "tt1234567", season: 2, episode: 8, videoHash: "abc", videoSize: 42 });
  });

  it("keeps a movie id whole and leaves episode fields unset", () => {
    expect(parseSubtitleRequest("movie", "tt1234567", undefined, ["ar"])).toEqual({
      type: "movie",
      contentId: "tt1234567",
      imdbId: "tt1234567",
      season: undefined,
      episode: undefined,
      videoHash: undefined,
      videoSize: undefined,
      filename: undefined,
      languages: ["ar"],
    });
  });

  it("decodes percent-encoded extras from the player", () => {
    const request = parseSubtitleRequest("movie", "tt1", encodeURIComponent("filename=A Movie (2024).mkv"), ["ar"]);
    expect(request.filename).toBe("A Movie (2024).mkv");
  });

  it("treats an unknown type as a movie", () => {
    expect(parseSubtitleRequest("channel", "tt1:2:3", undefined, ["ar"])).toMatchObject({ type: "movie", season: undefined });
  });

  it("ignores a non-numeric video size", () => {
    expect(parseSubtitleRequest("movie", "tt1", "videoSize=huge", ["ar"]).videoSize).toBeUndefined();
  });

  it("survives malformed percent escapes", () => {
    expect(parseSubtitleRequest("movie", "tt1%zz", "filename=%zz", ["ar"]).contentId).toBe("tt1%zz");
  });

  it("leaves a non-IMDb id without an imdbId", () => {
    expect(parseSubtitleRequest("movie", "kitsu:42", undefined, ["ar"]).imdbId).toBeUndefined();
  });
});
