# AutoSub

A self-hosted Stremio addon that delivers **one subtitle that is actually in sync**, verified against the audio of the exact release you are playing.

Subtitle addons normally hand the player a list of guesses named after releases they may or may not match. AutoSub does the opposite: it listens to a few seconds of the film you just started, checks candidate subtitles against what is actually being said, corrects constant offset and frame-rate drift, and returns a single track — or nothing at all, if nothing passes. It delivers Arabic, and only Arabic: when no Arabic subtitle survives validation, a validated timing track is translated by an AI model automatically, while its verified timestamps are left untouched.

Built to run on a Raspberry Pi 4 next to a Real-Debrid account, exposed through a Cloudflare Tunnel.

```
Stremio ──► AutoSub ──► your configured Torrentio/debrid addon
   │            │
   │            ├── ffmpeg samples ~4×15s of the release's audio
   │            ├── WebRTC VAD + Deepgram produce a speech/word timeline
   │            ├── OpenSubtitles / SubDL / SubSource are searched in parallel
   │            └── candidates are scored against that timeline
   │
   └──► plays straight from the debrid URL (a 302; video never passes through AutoSub)
```

## Contents

- [What you see while watching](#what-you-see-while-watching)
- [How it works](#how-it-works)
- [What travels where](#what-travels-where)
- [Requirements](#requirements)
- [Install](#install)
- [Configuration](#configuration)
- [Operating it](#operating-it)
- [Development](#development)
- [Documentation](#documentation)

## What you see while watching

One row in the subtitle menu: `Arabic`. Stremio's preferred-language setting selects it on its own, so there is nothing to choose. Behind that row AutoSub finds the best Arabic subtitle for the exact release, and when none fits it generates one with AI — the viewer never has to ask.

Stremio gives an addon no way to show a spinner, so AutoSub reports itself through the one channel a player always renders: the subtitle itself. The delivered file opens with a short line naming its origin — `[AutoSub] opensubtitles subtitle - 81% match` — that clears after a few seconds. If preparation is still running past `JOB_WAIT_MS` (an AI translation can take a couple of minutes), or nothing could be matched at all, a readable message appears on screen instead of silence; select `Arabic` again a minute later to load the finished subtitle.

Set `STATUS_BANNER=false` or `STATUS_MESSAGES=false` to turn either behaviour off.

## How it works

1. **Stream wrapping.** Stremio asks AutoSub for streams; AutoSub forwards the request to your configured upstream addon and replaces each direct URL with an opaque `/play` link, keeping filename, hash, size, and every other hint intact. Torrent-only results with no HTTP(S) debrid URL are dropped, so AutoSub never hands a client an `infoHash`.
2. **Release identity.** Opening a stream records exactly which release is playing — the one moment that identity is knowable — starts subtitle preparation in the background, and redirects the player to the original debrid URL.
3. **Audio sampling.** FFprobe picks the audio track matching TMDB's original language, otherwise a track marked *Original*, otherwise the container default. FFmpeg then pulls a handful of short mono samples spread across the title.
4. **Speech timeline.** WebRTC VAD builds a local speech-activity timeline; Deepgram adds word-level timestamps. Quiet or failed samples are selectively replaced, and a mislabelled audio track falls back to language detection.
5. **Candidate search.** OpenSubtitles, SubDL, and SubSource are searched concurrently and the results ranked by hash match, release-name similarity, source, group, edition, and frame rate.
6. **Validation.** Candidates are downloaded in waves — the best entry from each provider at a time — and scored against the speech timeline. A global model corrects constant delay and constrained frame-rate drift (50 ms / 0.01% precision). Anything that only fits in places is rejected.
7. **Arabic.** An Arabic candidate is accepted only when its cue events match the trusted track across the whole title. A source track that no candidate can align to is discarded and the next best one tried, because a subtitle cut for a different edit can match the audio and still be a useless reference.
8. **When the spoken language has nothing.** Some films — anime especially — have a handful of subtitles in their original language and hundreds in English. Speech activity is language-independent, so an English subtitle can be validated against the audio and then vouch for the Arabic one across the whole title. Failing even that, the Arabic track is checked against speech activity directly. Both answer to a higher confidence bar than a transcript match.
9. **Translation when nothing matches.** If no Arabic subtitle fits, the best validated timing track — the spoken-language one when it exists, otherwise the other-language reference from step 8 — is translated automatically. Timestamps never leave this process, and an answer that drops or reorders cues is rejected rather than applied. See [docs/translation.md](docs/translation.md) for choosing an engine.
10. **Caching.** The result is stored by release fingerprint and translation-engine version, so repeat plays are instant.

If nothing passes, AutoSub says so rather than serving a subtitle that drifts. See [docs/architecture.md](docs/architecture.md) for the full design and [docs/tuning.md](docs/tuning.md) for the confidence model.

## What travels where

| Connection | Data |
|---|---|
| TV → debrid | The video itself, directly after an HTTP 302 redirect |
| AutoSub → debrid | A few seconds of mono audio per title, plus replacements when a sample has no dialogue |
| AutoSub → subtitle providers | IMDb/release identifiers and subtitle downloads |
| AutoSub → translation engine | Validated subtitle text only, never timestamps |
| AutoSub → Deepgram | The mono audio samples |
| Tunnel → AutoSub | Stremio addon requests and finished subtitle files, never video bytes |

Every addon URL is prefixed with a private `INSTALL_TOKEN`. Treat the manifest URL as a credential: anyone holding it can use your addon.

## Requirements

- Node.js 20.11+, or Docker with the Compose plugin (the image bundles Node, FFmpeg, Python and WebRTC VAD, and is multi-architecture)
- A public HTTPS address — a Cloudflare Tunnel is the documented path
- A configured upstream stream addon URL (for example Torrentio with Real-Debrid)
- API keys for at least one subtitle provider; TMDB, Deepgram and a translation engine are strongly recommended

## Install

```bash
git clone https://github.com/jweaker/autosub.git
cd autosub
cp .env.example .env
openssl rand -hex 32      # paste into INSTALL_TOKEN
$EDITOR .env
chmod 600 .env

mkdir -p data && sudo chown 1000:1000 data
docker compose build
docker compose up -d
curl -fsS http://127.0.0.1:7000/healthz
```

The health response should report `upstream: true`, your providers, `audioAnalysis: true` and your translation engine.

Point a Cloudflare Tunnel public hostname at `http://localhost:7000`, set `PUBLIC_URL` to that hostname, then open:

```
https://your-hostname/YOUR_INSTALL_TOKEN/configure
```

and press **Install in Stremio**. Addon installations sync through your Stremio account, so TVs signed into the same account pick it up. Remove the standalone upstream addon afterwards — its unwrapped streams bypass AutoSub — and make your target language first in Stremio's subtitle preferences.

Full step-by-step instructions, including obtaining every API key, are in [docs/deployment.md](docs/deployment.md).

Running without Docker:

```bash
npm ci && npm run build
node --env-file=.env dist/server.js   # needs ffmpeg, ffprobe, and optionally python3 + webrtcvad-wheels
```

## Configuration

Every setting is an environment variable; [.env.example](.env.example) documents all of them with defaults. The ones that matter most:

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_URL` | `http://127.0.0.1:PORT` | Public HTTPS base URL of this instance |
| `INSTALL_TOKEN` | *(unset — refuses to be secure)* | Secret path prefix for every addon URL |
| `UPSTREAM_ADDON_URL` | — | Configured stream addon manifest to wrap |
| `MINIMUM_CONFIDENCE` | `58` | Reject anything scoring lower |
| `FALLBACK_REFERENCE_LANGUAGES` | `en` | Languages that may carry timing when the spoken language has no usable subtitle |
| `CANDIDATE_LIMIT` | `10` | Candidates downloaded and validated per language |
| `JOB_WAIT_MS` | `120000` | How long a subtitle request waits for preparation |
| `CACHE_TTL_DAYS` | `30` | Age at which cached subtitles are swept |
| `AUDIO_BUDGET_MB` | `240` | Ceiling on bytes one audio analysis may download |
| `TRANSLATION_PROVIDER` | `gemini` | `gemini`, `openai` (any chat-completions endpoint), `deepl`, or `libretranslate` |
| `TRANSLATION_REASONING_EFFORT` | `medium` | `reasoning_effort` sent to an `openai` endpoint |
| `TRANSLATION_CONCURRENCY` | `12` | Maximum independent AI batches; automatically reduced under endpoint backpressure (1–12) |
| `STATUS_BANNER` | `true` | Open each subtitle with a line naming its origin |
| `STATUS_MESSAGES` | `true` | Deliver progress and failures as a readable track |
| `DNS_SERVER` | `1.1.1.1` | Container resolver (Compose only); use one that resolves every provider hostname |

Invalid or out-of-range values are clamped rather than trusted, and the server prints a warning for each risky setting at startup (unset token, non-HTTPS public URL, missing upstream, disabled analysis).

## Operating it

```bash
docker compose logs -f --tail=200 autosub    # follow
curl -fsS http://127.0.0.1:7000/healthz      # providers, job counts, uptime
docker compose build --pull && docker compose up -d   # update
npm run smoke -- tt1234567                   # end-to-end check against a real title
curl -fsS $PUBLIC_URL/$INSTALL_TOKEN/stats   # what recent runs cost, stage by stage
```

Open `$PUBLIC_URL/$INSTALL_TOKEN/dashboard` for the human-readable operations page: success and failure rates, AI token usage, Deepgram audio usage, recent runs, and selective cache deletion. Treat the URL as a credential.

Each finished subtitle carries `X-AutoSub-Confidence`, `X-AutoSub-Provider`, `X-AutoSub-Translated` and `X-AutoSub-Variant` headers, and the logs record the chosen provider, language, confidence, offset and rate for every run. [docs/operations.md](docs/operations.md) covers failure modes, status codes and troubleshooting.

## Development

```bash
npm ci
npm run check        # typecheck + tests + build
npm test             # vitest
npm run dev          # tsx watch
```

No provider credentials are needed for the test suite; network calls and media tooling are stubbed. Source layout and invariants are described in [docs/architecture.md](docs/architecture.md).

## Documentation

- [docs/architecture.md](docs/architecture.md) — module map, request lifecycle, design decisions
- [docs/deployment.md](docs/deployment.md) — Raspberry Pi, Cloudflare Tunnel, and every API key
- [docs/translation.md](docs/translation.md) — choosing and configuring a translation engine
- [docs/tuning.md](docs/tuning.md) — how confidence is computed and how to adjust matching
- [docs/operations.md](docs/operations.md) — health, logs, status codes, troubleshooting
- [SECURITY.md](SECURITY.md) — trust boundaries and reporting

## License

[MIT](LICENSE). AutoSub talks to third-party services under their own terms; you are responsible for holding valid accounts and for the content you play.
