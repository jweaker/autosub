export interface AppConfig {
  port: number;
  publicUrl: string;
  defaultLanguages: string[];
  providerTimeoutMs: number;
  minimumConfidence: number;
  referenceLanguages: string[];
  upstreamAddonUrl?: string;
  audioAnalysisEnabled: boolean;
  dataDir: string;
  installToken: string;
  jobWaitMs: number;
  candidateLimit: number;
  ffmpegPath: string;
  ffprobePath: string;
  pythonPath: string;
  vadScriptPath: string;
  audioSampleCount: number;
  audioSampleSeconds: number;
  audioConcurrency: number;
  maxSyncOffsetSeconds: number;
  streamTtlMs: number;
  cacheTtlMs: number;
  rateLimitPerMinute: number;
  tmdbToken?: string;
  gemini: { apiKey?: string; model: string; concurrency: number };
  deepgram: { apiKey?: string; model: string };
  openSubtitles: {
    apiKey?: string;
    username?: string;
    password?: string;
    userAgent: string;
  };
  subDl: { apiKey?: string };
  subSource: { apiKey?: string };
}

export const INSECURE_TOKEN = "change-me-before-exposing";

const asNumber = (value: string | undefined, fallback: number, minimum: number, maximum: number): number => {
  const parsed = Number.parseFloat(value ?? "");
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
};

const asInt = (value: string | undefined, fallback: number, minimum: number, maximum: number): number =>
  Math.round(asNumber(value, fallback, minimum, maximum));

const asList = (value: string | undefined): string[] =>
  (value || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = asInt(env.PORT, 7000, 1, 65_535);
  const publicUrl = (env.PUBLIC_URL || `http://127.0.0.1:${port}`).replace(/\/+$/, "");
  const defaultLanguages = asList(env.DEFAULT_LANGUAGES);

  return {
    port,
    publicUrl,
    defaultLanguages: defaultLanguages.length ? defaultLanguages : ["ar"],
    providerTimeoutMs: asInt(env.PROVIDER_TIMEOUT_MS, 8_000, 1_000, 60_000),
    minimumConfidence: asInt(env.MINIMUM_CONFIDENCE, 58, 0, 100),
    referenceLanguages: asList(env.REFERENCE_LANGUAGES),
    upstreamAddonUrl: env.UPSTREAM_ADDON_URL?.replace(/\/+$/, ""),
    audioAnalysisEnabled: env.AUDIO_ANALYSIS_ENABLED !== "false",
    dataDir: env.DATA_DIR || "./data",
    installToken: env.INSTALL_TOKEN || INSECURE_TOKEN,
    jobWaitMs: asInt(env.JOB_WAIT_MS, 120_000, 5_000, 600_000),
    candidateLimit: asInt(env.CANDIDATE_LIMIT, 10, 1, 50),
    ffmpegPath: env.FFMPEG_PATH || "ffmpeg",
    ffprobePath: env.FFPROBE_PATH || "ffprobe",
    pythonPath: env.PYTHON_PATH || "python3",
    vadScriptPath: env.VAD_SCRIPT_PATH || "scripts/vad.py",
    audioSampleCount: asInt(env.AUDIO_SAMPLE_COUNT, 4, 3, 12),
    audioSampleSeconds: asInt(env.AUDIO_SAMPLE_SECONDS, 15, 5, 60),
    audioConcurrency: asInt(env.AUDIO_CONCURRENCY, 4, 1, 8),
    maxSyncOffsetSeconds: asNumber(env.MAX_SYNC_OFFSET_SECONDS, 180, 5, 900),
    streamTtlMs: asNumber(env.STREAM_TTL_HOURS, 6, 0.25, 168) * 3_600_000,
    cacheTtlMs: asNumber(env.CACHE_TTL_DAYS, 30, 0, 3_650) * 86_400_000,
    rateLimitPerMinute: asInt(env.RATE_LIMIT_PER_MINUTE, 180, 10, 100_000),
    tmdbToken: env.TMDB_API_TOKEN,
    gemini: {
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL || "gemini-3.5-flash",
      concurrency: asInt(env.TRANSLATION_CONCURRENCY, 2, 1, 8),
    },
    deepgram: {
      apiKey: env.DEEPGRAM_API_KEY,
      model: env.DEEPGRAM_MODEL || "nova-3",
    },
    openSubtitles: {
      apiKey: env.OPENSUBTITLES_API_KEY,
      username: env.OPENSUBTITLES_USERNAME,
      password: env.OPENSUBTITLES_PASSWORD,
      userAgent: env.OPENSUBTITLES_USER_AGENT || "AutoSub v1.0",
    },
    subDl: { apiKey: env.SUBDL_API_KEY },
    subSource: { apiKey: env.SUBSOURCE_API_KEY },
  };
}

/** Startup problems worth telling the operator about, in severity order. */
export function configWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];
  if (config.installToken === INSECURE_TOKEN) {
    warnings.push("INSTALL_TOKEN is unset; set it to a long random value before exposing this service");
  } else if (config.installToken.length < 24) {
    warnings.push("INSTALL_TOKEN is short; use at least 32 hex characters (openssl rand -hex 32)");
  }
  if (!config.upstreamAddonUrl) warnings.push("UPSTREAM_ADDON_URL is unset; AutoSub will return no streams");
  if (!config.publicUrl.startsWith("https://")) warnings.push(`PUBLIC_URL is not HTTPS (${config.publicUrl}); Stremio clients may refuse to install the addon`);
  if (!config.audioAnalysisEnabled) warnings.push("AUDIO_ANALYSIS_ENABLED=false; subtitles cannot be validated and every request will fail");
  if (!config.gemini.apiKey) warnings.push("GEMINI_API_KEY is unset; translation fallback is disabled");
  if (!config.deepgram.apiKey) warnings.push("DEEPGRAM_API_KEY is unset; falling back to speech-activity matching only");
  return warnings;
}
