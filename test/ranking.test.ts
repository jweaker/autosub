import { describe, expect, it } from "vitest";
import type { SubtitleCandidate, SubtitleRequest } from "../src/domain.js";
import { rankCandidate, rankCandidates } from "../src/ranking.js";
import { parseRelease, tokenSimilarity } from "../src/release.js";

const request: SubtitleRequest = {
  type: "movie",
  contentId: "tt1234567",
  imdbId: "tt1234567",
  filename: "Dune.Part.Two.2024.1080p.BluRay.x264-GROUP.mkv",
  languages: ["ar"],
};

const candidate = (overrides: Partial<SubtitleCandidate>): SubtitleCandidate => ({
  provider: "opensubtitles",
  providerId: "1",
  language: "ar",
  locator: {},
  ...overrides,
});

describe("candidate ranking", () => {
  it("puts a hash match first", () => {
    const ranked = rankCandidates(request, [
      candidate({ providerId: "plain", release: "Dune.Part.Two.2024.1080p.WEB-DL" }),
      candidate({ providerId: "hash", release: "Unknown release", hashMatch: true }),
    ]);
    expect(ranked[0].candidate.providerId).toBe("hash");
    expect(ranked[0].reasons).toContain("exact video hash");
  });

  it("rewards a matching source and release group", () => {
    const same = rankCandidate(request, candidate({ release: "Dune.Part.Two.2024.1080p.BluRay.x264-GROUP" }));
    const different = rankCandidate(request, candidate({ release: "Dune.Part.Two.2024.HDTV.x264-OTHER" }));
    expect(same.score).toBeGreaterThan(different.score);
    expect(same.reasons).toContain("same release group");
  });

  it("rejects a subtitle for the wrong episode", () => {
    const episodeRequest: SubtitleRequest = { ...request, type: "series", season: 2, episode: 8, filename: "Show.S02E08.1080p.WEB.mkv" };
    const wrong = rankCandidate(episodeRequest, candidate({ release: "Show.S02E09.1080p.WEB" }));
    const right = rankCandidate(episodeRequest, candidate({ release: "Show.S02E08.1080p.WEB" }));
    expect(wrong.score).toBe(0);
    expect(right.score).toBeGreaterThan(wrong.score);
  });

  it("penalises an edition mismatch", () => {
    const extended = rankCandidate(
      { ...request, filename: "Movie.2024.Extended.1080p.BluRay-GROUP.mkv" },
      candidate({ release: "Movie.2024.Theatrical.1080p.BluRay-GROUP" }),
    );
    const matching = rankCandidate(
      { ...request, filename: "Movie.2024.Extended.1080p.BluRay-GROUP.mkv" },
      candidate({ release: "Movie.2024.Extended.1080p.BluRay-GROUP" }),
    );
    expect(matching.score).toBeGreaterThan(extended.score);
  });

  it("keeps scores inside the documented range", () => {
    const best = rankCandidate(request, candidate({ hashMatch: true, release: request.filename, rating: 10, downloadCount: 1_000_000 }));
    const worst = rankCandidate(request, candidate({ release: "Other.Movie.2001.DVDRip-XYZ", machineTranslated: true }));
    expect(best.score).toBeLessThanOrEqual(100);
    expect(worst.score).toBeGreaterThanOrEqual(0);
  });
});

describe("release parsing", () => {
  it("extracts source, group, and episode numbers", () => {
    expect(parseRelease("Show.S03E11.2021.1080p.WEB-DL.DDP5.1-TEAM.mkv")).toMatchObject({
      source: "web",
      season: 3,
      episode: 11,
      group: "team",
    });
  });

  it("recognizes compact BDRemux names used by UHD releases", () => {
    expect(parseRelease("MUFASA.2024.2160p.UHD.BDRemux.HDR.DV.HEVC-Нечипорук.mkv")?.source).toBe("bluray");
  });

  it("prefers a remux timing track over a generic Blu-ray encode for a remux video", () => {
    const remuxRequest = { ...request, filename: "Movie.2024.2160p.UHD.BDRemux.HDR.DV.mkv" };
    const remux = rankCandidate(remuxRequest, candidate({ release: "Movie.2024.1080p.Blu-ray.Remux.AVC-HDT" }));
    const encode = rankCandidate(remuxRequest, candidate({ release: "Movie.2024.1080p.BluRay.x264-KNiVES" }));
    expect(remux.score).toBeGreaterThan(encode.score);
    expect(remux.reasons).toContain("same remux cut family");
  });

  it("ignores quality tokens when comparing names", () => {
    const similarity = tokenSimilarity("Movie.2024.1080p.x265-GROUP.mkv", "Movie.2024.2160p.x264-GROUP");
    expect(similarity).toBeGreaterThan(0.7);
    expect(tokenSimilarity("Movie.2024-GROUP", "Other.1999-TEAM")).toBeLessThan(0.3);
  });
});
