import type { AppConfig } from "../config.js";
import type { SubtitleProvider } from "../domain.js";
import { OpenSubtitlesProvider } from "./open-subtitles.js";
import { SubDlProvider } from "./subdl.js";
import { SubSourceProvider } from "./subsource.js";

/** Only providers with credentials are constructed; the rest stay out of the search fan-out. */
export function createProviders(config: AppConfig): SubtitleProvider[] {
  return [
    new OpenSubtitlesProvider({ ...config.openSubtitles, timeoutMs: config.providerTimeoutMs }),
    new SubDlProvider(config.subDl.apiKey, config.providerTimeoutMs),
    new SubSourceProvider(config.subSource.apiKey, config.providerTimeoutMs),
  ].filter((provider) => provider.enabled);
}
