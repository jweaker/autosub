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
  /** Ceiling on how many bytes one audio analysis may pull from the release. */
  audioBudgetBytes: number;
  maxSyncOffsetSeconds: number;
  streamTtlMs: number;
  cacheTtlMs: number;
  rateLimitPerMinute: number;
  /** Deliver progress and failure notices as a readable subtitle track. */
  statusMessages: boolean;
  /** Prepend a short "what you are watching" cue to finished subtitles. */
  statusBanner: boolean;
  /** Add status and "try another" entries to the subtitle menu. */
  menuEntries: boolean;
  /** How many "try another" rows to offer, each usable once per playback. */
  retryEntries: number;
  /** How long the subtitle list waits before labelling a job as preparing. */
  statusProbeMs: number;
  /** How long a subtitle request waits for the play redirect to name the release. */
  streamWaitMs: number;
  tmdbToken?: string;
  /**
   * `auto` translates whenever nothing matches, `manual` only when the viewer
   * asks for it from the subtitle menu, `off` never.
   */
  translationMode: "auto" | "manual" | "off";
  translation: {
    /** Which backend performs the translation when one is asked for. */
    provider: "gemini" | "openai" | "deepl" | "libretranslate";
    apiKey?: string;
    /** Endpoint for OpenAI-compatible and self-hosted backends. */
    baseUrl?: string;
    model: string;
    concurrency: number;
  };
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

const PROVIDERS = ["gemini", "openai", "deepl", "libretranslate"] as const;
type TranslationProvider = (typeof PROVIDERS)[number];

const asProvider = (value: string | undefined): TranslationProvider =>
  (PROVIDERS as readonly string[]).includes(value || "") ? (value as TranslationProvider) : "gemini";

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
    audioBudgetBytes: asNumber(env.AUDIO_BUDGET_MB, 240, 32, 4_096) * 1024 * 1024,
    maxSyncOffsetSeconds: asNumber(env.MAX_SYNC_OFFSET_SECONDS, 180, 5, 900),
    streamTtlMs: asNumber(env.STREAM_TTL_HOURS, 6, 0.25, 168) * 3_600_000,
    cacheTtlMs: asNumber(env.CACHE_TTL_DAYS, 30, 0, 3_650) * 86_400_000,
    rateLimitPerMinute: asInt(env.RATE_LIMIT_PER_MINUTE, 180, 10, 100_000),
    translationMode: env.TRANSLATION_MODE === "auto" || env.TRANSLATION_MODE === "off" ? env.TRANSLATION_MODE : "manual",
    statusMessages: env.STATUS_MESSAGES !== "false",
    statusBanner: env.STATUS_BANNER !== "false",
    menuEntries: env.MENU_ENTRIES !== "false",
    retryEntries: asInt(env.RETRY_ENTRIES, 3, 0, 10),
    statusProbeMs: asInt(env.STATUS_PROBE_MS, 2_000, 0, 15_000),
    streamWaitMs: asInt(env.STREAM_WAIT_MS, 12_000, 100, 60_000),
    tmdbToken: env.TMDB_API_TOKEN,
    translation: {
      provider: asProvider(env.TRANSLATION_PROVIDER),
      apiKey: env.TRANSLATION_API_KEY || (asProvider(env.TRANSLATION_PROVIDER) === "gemini" ? env.GEMINI_API_KEY : undefined),
      baseUrl: env.TRANSLATION_BASE_URL,
      model: env.TRANSLATION_MODEL || env.GEMINI_MODEL || "gemini-3.5-flash",
      concurrency: asInt(env.TRANSLATION_CONCURRENCY, 2, 1, 8),
    },
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

/** Whether the selected translation backend has everything it needs. */
export function translationConfigured(config: AppConfig): boolean {
  const { provider, apiKey, baseUrl } = config.translation;
  if (provider === "openai" || provider === "libretranslate") return Boolean(baseUrl);
  return Boolean(apiKey);
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
  if (config.translationMode !== "off" && !translationConfigured(config)) {
    warnings.push(`Translation provider "${config.translation.provider}" is not fully configured; translation is unavailable`);
  }
  if (!config.deepgram.apiKey) warnings.push("DEEPGRAM_API_KEY is unset; falling back to speech-activity matching only");
  return warnings;
}
