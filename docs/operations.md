# Operations

## Endpoints

| Route | Purpose |
|---|---|
| `GET /healthz` | Unauthenticated liveness and configuration summary |
| `GET /` | Static page that deliberately reveals nothing |
| `GET /:token/configure` | Install page with the deep link and manifest URL |
| `GET /:token/manifest.json` | Stremio addon manifest |
| `GET /:token/stream/:type/:id.json` | Upstream streams, rewritten as play links |
| `GET /:token/play/:playId` | Records the release, starts preparation, 302s to the debrid URL |
| `GET /:token/subtitles/:type/:id[/:extra].json` | Subtitle list for the release being played |
| `GET /:token/file/:jobId.srt` | The finished subtitle |

Anything with a wrong token returns 404, compared in constant time.

## Health

```bash
curl -fsS http://127.0.0.1:7000/healthz | jq
```

```json
{
  "ok": true,
  "upstream": true,
  "audioAnalysis": true,
  "providers": ["opensubtitles", "subdl", "subsource"],
  "translation": "gemini",
  "languageDetectionFallback": "deepgram",
  "jobs": { "tracked": 3, "running": 1 },
  "uptimeSeconds": 84213
}
```

A provider missing from `providers` has no API key configured. `translation: "disabled"` means no Gemini key, so a title with no direct target-language match will simply fail.

## Status codes

| Code | Meaning | What to do |
|---|---|---|
| 404 | Bad token, or a job that has aged out | Reopen the title in Stremio |
| 410 | Play link older than `STREAM_TTL_HOURS` | Reopen the title |
| 422 | Nothing matched the audio | Expected sometimes; see [tuning](tuning.md) |
| 429 | Rate limit | Raise `RATE_LIMIT_PER_MINUTE` if it is your own traffic |
| 502 | Upstream addon or provider fault | Check logs and the provider's status |
| 504 | Still preparing after `JOB_WAIT_MS` | Work continues; the retry usually hits the cache |

## Logs

```bash
docker compose logs -f --tail=200 autosub
```

Two lines describe every cold run:

```
Audio analysis completed with 4 windows (4 primary) and 4 transcripts; language=en; elapsed=18342ms
Trusted timing selected from opensubtitles; language=en; confidence=81; midpointOffsetMs=-1250; rate=1.000000; audioWindows=4; elapsed=24011ms
```

Then one of:

```
Direct ar subtitle selected from subdl; ...
No direct ar timing match; translating trusted en timing with gemini-3.5-flash
```

Warnings that are normal in small numbers: a provider search failing (the others continue), a candidate failing to download or parse (the next wave runs), `WebRTC VAD unavailable` (the energy fallback is in use — worth fixing, but not fatal).

## Data and housekeeping

```
data/streams.json      play-link registry
data/subtitles/        cached results
```

Both are safe to delete while the service is stopped: the registry rebuilds as titles are browsed, and the cache re-derives on the next play. Expired registry records and cached subtitles older than `CACHE_TTL_DAYS` are swept hourly and at startup.

To force a re-run for one title, delete its `data/subtitles/<key>.*` pair — or simply bump `GEMINI_MODEL`, which invalidates translated entries by design.

## Restarting and updating

```bash
docker compose build --pull && docker compose up -d
```

The server handles `SIGTERM`: it stops accepting connections, lets in-flight requests finish, and exits within 15 seconds (`stop_grace_period` allows 20). In-flight preparation is lost, but the next request restarts it.

Updating never changes the addon URL. Only changing `PUBLIC_URL` or `INSTALL_TOKEN` does, and that requires reinstalling the addon in every Stremio client.

## Smoke test

```bash
npm run smoke -- tt1234567           # first available release
npm run smoke -- tt1234567 --list    # list releases
npm run smoke -- tt1234567 2160p     # pick one by name fragment
```

It exercises the real path — streams, play redirect, subtitle list, file — and prints provider, confidence, cue count and the first timestamps. It needs `.env` and consumes real provider quota.
