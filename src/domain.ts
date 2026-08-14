export type MediaType = "movie" | "series";

export interface SubtitleRequest {
  type: MediaType;
  contentId: string;
  imdbId?: string;
  season?: number;
  episode?: number;
  videoHash?: string;
  videoSize?: number;
  filename?: string;
  languages: string[];
}

export interface StreamRecord {
  playId: string;
  type: string;
  contentId: string;
  url: string;
  filename?: string;
  videoHash?: string;
  videoSize?: number;
  requestHeaders?: Record<string, string>;
  discoveredAt: number;
}

export interface SubtitleCue {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface SpeechInterval {
  startMs: number;
  endMs: number;
}

export interface TranscriptWord {
  word: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  language?: string;
}

export interface VadWindow {
  startMs: number;
  durationMs: number;
  speech: SpeechInterval[];
  transcript?: string;
  words?: TranscriptWord[];
}

export interface AudioProbeResult {
  durationMs: number;
  audioLanguage?: string;
  audioStreamIndex: number;
  windows: VadWindow[];
  /** Wall-clock cost of each stage, reported by /stats. */
  timings?: { resolveMs: number; probeMs: number; sampleMs: number; totalMs: number };
  /** Sample length actually used, which adapts to the release's bitrate. */
  sampleSeconds?: number;
  megabitsPerSecond?: number;
}

export interface AlignmentResult {
  cues: SubtitleCue[];
  confidence: number;
  offsetMs: number;
  rate?: number;
  anchors: Array<{ subtitleMs: number; offsetMs: number; score: number }>;
}

export interface CompletedSubtitle {
  key: string;
  /**
   * Identifies which candidate produced this file, so a viewer can reject it
   * and ask for the next one. Direct matches use `provider:providerId`;
   * translations prefix the source track's id with `gemini:`.
   */
  id: string;
  language: string;
  content: string;
  confidence: number;
  provider: string;
  translated: boolean;
  sourceLanguage?: string;
}

export interface ReleaseSignature {
  normalized: string;
  source?: "bluray" | "web" | "hdtv" | "dvd";
  group?: string;
  edition?: string;
  fps?: number;
  season?: number;
  episode?: number;
}

export interface SubtitleCandidate {
  provider: string;
  providerId: string;
  language: string;
  release?: string;
  filename?: string;
  format?: string;
  fps?: number;
  hearingImpaired?: boolean;
  machineTranslated?: boolean;
  aiTranslated?: boolean;
  hashMatch?: boolean;
  rating?: number;
  downloadCount?: number;
  locator: Record<string, string | number | boolean | undefined>;
}

export interface RankedCandidate {
  candidate: SubtitleCandidate;
  score: number;
  reasons: string[];
}

export interface SubtitleProvider {
  readonly name: string;
  readonly enabled: boolean;
  search(request: SubtitleRequest, signal: AbortSignal): Promise<SubtitleCandidate[]>;
  download(candidate: SubtitleCandidate, signal: AbortSignal): Promise<Uint8Array>;
}
