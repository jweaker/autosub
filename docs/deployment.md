# Deployment

This is the full path from a bare Raspberry Pi to AutoSub installed on a TV. Any always-on Linux host with Docker works the same way; the Pi is simply what this was built and tested on.

## What you need

- Raspberry Pi 4 (4 GB) with 64-bit Raspberry Pi OS, or any Docker host
- Docker Engine with the Compose plugin (`docker compose version` must succeed)
- A domain on Cloudflare and a `cloudflared` connector running on the host
- A Stremio account, signed in on both the setup device and the TVs
- A configured upstream stream addon URL (Torrentio + Real-Debrid in this guide)

The container image bundles Node.js 20, FFmpeg/FFprobe, Python and WebRTC VAD. No local generative model is used.

## 1. Put the project on the host

```bash
git clone https://github.com/jweaker/autosub.git
cd autosub
cp .env.example .env
openssl rand -hex 32
$EDITOR .env
chmod 600 .env
mkdir -p data
sudo chown 1000:1000 data
```

Paste the generated random value into `INSTALL_TOKEN`. Never commit `.env`, and never share the resulting manifest URL — it is the only thing protecting the addon.

If a credential contains `#`, `$`, spaces, or other punctuation, wrap its `.env` value in single quotes.

## 2. Fill in credentials

### Upstream streams (Torrentio + Real-Debrid)

Open Torrentio's setup page, configure your Real-Debrid account normally, and copy the complete **configured manifest URL**:

```dotenv
UPSTREAM_ADDON_URL=https://.../manifest.json
```

That URL normally embeds the Real-Debrid credential, so AutoSub needs no second token. Never share or publish it.

### OpenSubtitles

1. Create or sign into an account at [opensubtitles.com](https://www.opensubtitles.com/).
2. Open the API Consumers page and create a consumer/API key.
3. Fill in `OPENSUBTITLES_API_KEY`, `OPENSUBTITLES_USERNAME`, `OPENSUBTITLES_PASSWORD`, and a descriptive `OPENSUBTITLES_USER_AGENT`.

The login is used only to obtain a short-lived download token, and only when a candidate is actually downloaded.

### SubDL

1. Sign in at [SubDL](https://subdl.com/).
2. Open the API panel and create a Search & Download API key.
3. Put it in `SUBDL_API_KEY`.

### SubSource

1. Sign in at [SubSource](https://subsource.net/).
2. Open **My Profile** and generate an API key.
3. Put it in `SUBSOURCE_API_KEY`.

SubSource documents a 60 requests/minute and 7,200 requests/day limit. AutoSub searches once per release and caches the result.

### TMDB

1. Sign in at [TMDB](https://www.themoviedb.org/).
2. Open Account Settings → API and request API access if necessary.
3. Copy the **API Read Access Token** (the long bearer token, not a session token) into `TMDB_API_TOKEN`.

This supplies the original language, which selects both the audio track and the source-language subtitle search.

### Gemini

1. Open [Google AI Studio API keys](https://aistudio.google.com/app/apikey).
2. Create a key restricted to the Gemini API.
3. Put it in `GEMINI_API_KEY`.

`GEMINI_MODEL` is configurable because Google retires model versions. Translation runs only when no target-language subtitle passes validation.

### Deepgram

Create a Deepgram project key and put it in `DEEPGRAM_API_KEY`. AutoSub sends the short mono samples so the source-language subtitle can be verified against actual spoken words. Without it, AutoSub falls back to speech-activity matching only, which is measurably weaker — transcription-backed validation is the intended production mode.

## 3. Create the Cloudflare Tunnel

In Cloudflare Zero Trust:

1. Networks → Tunnels, create or select a tunnel whose connector runs on the host.
2. Add a public hostname, e.g. `autosub.yourdomain.com`.
3. Set its service URL to `http://localhost:7000`.
4. Set `PUBLIC_URL=https://autosub.yourdomain.com` in `.env`.

The tunnel exposes only AutoSub's HTTP service. Video playback is redirected away from it and never crosses the tunnel.

## 4. Start and verify

```bash
docker compose build
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:7000/healthz
```

Expect `upstream: true`, every configured provider listed, `audioAnalysis: true`, and `translation: gemini`. Startup warnings about a weak token, a non-HTTPS `PUBLIC_URL`, or a missing upstream appear in `docker compose logs autosub`.

Then confirm the private manifest from another machine:

```
https://autosub.yourdomain.com/YOUR_INSTALL_TOKEN/manifest.json
```

## 5. Install in Stremio

Use a phone or computer first, signed into the same Stremio account as the TVs:

1. Open `https://autosub.yourdomain.com/YOUR_INSTALL_TOKEN/configure`.
2. Press **Install in Stremio**. If the deep link is blocked, paste the displayed HTTPS manifest URL into Stremio's "Add addon" box.
3. **Remove the standalone upstream addon** (Torrentio). Its unwrapped duplicate streams bypass AutoSub entirely.
4. Remove other subtitle addons for a deterministic result, or at minimum make your target language first in the preferred-subtitle list.
5. In playback settings, keep original/default audio selected.

Installations sync through the Stremio account. Reopen Stremio on the TV, confirm AutoSub appears under installed addons, and play a title.

On a Raspberry Pi 4, a cold run that finds a direct subtitle typically takes around half a minute; quiet sources and AI translation take longer. Cached releases are immediate.

## Updating

```bash
git pull
docker compose build --pull
docker compose up -d
```

Nothing about the addon URL changes across updates, so Stremio does not need to reinstall anything. The manifest URL only changes if you change `PUBLIC_URL` or `INSTALL_TOKEN` — those do require reinstalling in every client.

## Running without Docker

```bash
sudo apt install ffmpeg python3 python3-venv
python3 -m venv .venv && .venv/bin/pip install -r requirements-vad.txt
npm ci && npm run build
PYTHON_PATH=.venv/bin/python node --env-file=.env dist/server.js
```

`FFMPEG_PATH`, `FFPROBE_PATH`, `PYTHON_PATH`, `VAD_SCRIPT_PATH` and `DATA_DIR` exist for exactly this case. WebRTC VAD is optional; without it AutoSub uses a built-in energy VAD and says so in the logs.
