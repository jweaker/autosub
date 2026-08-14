import type { RankedCandidate, SubtitleCandidate, SubtitleRequest } from "./domain.js";
import { parseRelease, tokenSimilarity } from "./release.js";

export function rankCandidate(request: SubtitleRequest, candidate: SubtitleCandidate): RankedCandidate {
  let score = 10;
  const reasons: string[] = [];
  const video = parseRelease(request.filename);
  const subtitle = parseRelease(candidate.release || candidate.filename);

  if (candidate.hashMatch) {
    score += 65;
    reasons.push("exact video hash");
  }

  if (request.filename && (candidate.release || candidate.filename)) {
    const similarity = tokenSimilarity(request.filename, candidate.release || candidate.filename || "");
    score += Math.round(similarity * 30);
    if (similarity >= 0.65) reasons.push("strong release-name match");
  }

  if (video?.source && subtitle?.source) {
    if (video.source === subtitle.source) {
      score += 12;
      reasons.push(`same ${video.source} source`);
    } else {
      score -= 18;
    }
  }

  if (video?.group && subtitle?.group && video.group === subtitle.group) {
    score += 18;
    reasons.push("same release group");
  }

  if (video?.edition && subtitle?.edition) {
    score += video.edition === subtitle.edition ? 18 : -35;
  } else if (video?.edition || subtitle?.edition) {
    score -= 15;
  }

  const videoFps = video?.fps;
  if (videoFps && candidate.fps) {
    const delta = Math.abs(videoFps - candidate.fps);
    score += delta < 0.01 ? 8 : delta > 0.5 ? -12 : 0;
  }

  if (request.season && subtitle?.season && request.season !== subtitle.season) score -= 100;
  if (request.episode && subtitle?.episode && request.episode !== subtitle.episode) score -= 100;
  if (candidate.machineTranslated || candidate.aiTranslated) score -= 8;
  if (candidate.rating) score += Math.min(8, Math.round(candidate.rating));
  if (candidate.downloadCount) score += Math.min(5, Math.floor(Math.log10(candidate.downloadCount + 1)));

  return { candidate, score: Math.max(0, Math.min(100, score)), reasons };
}

export function rankCandidates(request: SubtitleRequest, candidates: SubtitleCandidate[]): RankedCandidate[] {
  return candidates
    .map((candidate) => rankCandidate(request, candidate))
    .sort((left, right) => right.score - left.score);
}
