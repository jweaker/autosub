# Architecture

AutoSub is a single Node process. It speaks the Stremio addon protocol, shells out to FFmpeg for audio, and keeps a small amount of state on disk. There is no database and no queue.

## Why it is shaped this way

Stremio asks for subtitles without saying which stream the user picked. A subtitle addon therefore normally cannot know the release, the frame rate, or the cut it is being asked to caption — which is why lists of "matching" subtitles are mostly guesses.

AutoSub solves this by also being the *stream* addon. It wraps the upstream (debrid) streams in opaque `/play` links, so the moment the user starts playback, AutoSub learns exactly which file is playing, and can go listen to it.

Two consequences follow from that decision, and they explain most of the code:

- **The play redirect is the only identity signal**, so it must start work immediately (`app.ts` → `JobManager.start`) and the registry that remembers it must survive restarts (`streams.ts`).
- **Everything downstream is verifiable**, so a subtitle is never accepted on a name match alone. Matching is a numerical fit against the audio (`alignment.ts`), and a failure to fit is reported as a failure, not as a best guess.

## Module map

| Module | Responsibility |
|---|---|
| `server.ts` | Process bootstrap: wiring, listener, maintenance timers, shutdown |
| `app.ts` | HTTP surface, token authorization, rate limiting, error mapping |
| `config.ts` | Environment parsing, range clamping, startup warnings |
| `streams.ts` | Upstream addon client and the play-link registry |
| `request.ts` | Parsing Stremio's subtitle request format |
| `jobs.ts` | One pipeline run per release/language/rejection set, shared by all waiters |
| `status.ts` | Menu labels, origin banner, and message tracks |
| `rejections.ts` | Subtitles the viewer marked as wrong, per release |
| `pipeline.ts` | Orchestration: search → validate → translate → cache |
| `audio.ts` | ffprobe/ffmpeg sampling, VAD, Deepgram transcription |
| `process.ts` | Child-process execution with timeouts and output limits |
| `alignment.ts` | Scoring a subtitle against speech, transcripts, or a reference track |
| `ranking.ts`, `release.ts` | Ordering candidates by release-name evidence |
| `providers/` | OpenSubtitles, SubDL, SubSource clients |
| `subtitle-content.ts` | Unzip, encoding detection, ASS/VTT → SRT |
| `srt.ts` | SRT parse and serialize |
| `translation.ts` | Gemini translation under a fixed cue schema |
| `cache.ts` | Finished subtitles on disk, keyed by release fingerprint |
| `http.ts` | One timeout/retry/backoff policy for every outbound call |
| `metadata.ts` | TMDB original-language lookup |
| `languages.ts` | Language-code normalization |

## Request lifecycle

```
GET /:token/stream/:type/:id.json
    └─ upstream addon → StreamRegistry.wrap → play links returned to Stremio

GET /:token/play/:playId
    ├─ StreamRegistry.select      (records the release, wakes subtitle waiters)
    ├─ JobManager.start           (pipeline begins in the background)
    └─ 302 → debrid URL           (video never passes through AutoSub)

GET /:token/subtitles/:type/:id.json
    ├─ StreamRegistry.waitFor     (resolves the instant the play link is opened)
    └─ one subtitle entry per configured language, each pointing at a job

GET /:token/file/:jobId.srt
    └─ JobManager.result          (awaits the shared job, up to JOB_WAIT_MS)

GET /:token/next/:jobId.srt
    ├─ RejectionStore.add         (this release will never serve that file again)
    ├─ JobManager.start           (same release, larger exclusion set)
    └─ the replacement subtitle
```

The subtitle list is requested *before* or *around* the play redirect depending on the client, which is why `waitFor` exists: it blocks briefly on the registry rather than returning an empty list.

## The pipeline

`AutoSubPipeline.complete()` runs the expensive path once per release and language:

1. **Cache probe.** The key covers the media fingerprint, the target language, the rejection set, and the translation model, so changing the model invalidates translated entries but not direct ones, and every rejection generation caches separately.
2. **Parallel start.** Audio analysis and provider searches are launched together; the searches for the source language do not wait for the probe.
3. **Source validation.** Candidates in the original language are aligned against the transcript (`alignSubtitleToTranscript`). The winner becomes the *trusted timing track*.
4. **Target validation.** Candidates in the target language are aligned against that trusted track (`alignSubtitleToReference`). A match is served directly, with the lower of the two confidences.
5. **Translation fallback.** If nothing matches, Gemini translates the trusted track's text. The model sees cue ids and text only.
6. **Store.** Success is written to the cache; a cache write failure costs time on the next play but never fails the request.

Each result carries a variant id — `provider:providerId`, or that id prefixed with `gemini:` for a translation — which is what a rejection records. Rejecting a translation bars its source track, because reusing that track would produce the same translation again. Audio probes are kept in memory per release, so a rejection-driven re-run skips ffmpeg entirely and finishes in seconds.

Candidates are downloaded in waves of up to three, taking the best remaining entry from distinct providers, so a single provider's near-duplicate files cannot consume the whole budget (and, for OpenSubtitles, the account's download quota).

## Alignment

Three related searches share one machine (`searchMapping`): a coarse sweep over common frame-rate ratios and offsets, then a fine sweep around the winner.

| Function | Compares | Used for |
|---|---|---|
| `alignSubtitle` | cue spans vs. VAD speech bins | fallback when transcription is unavailable |
| `alignSubtitleToTranscript` | cue text vs. transcribed words, plus activity | choosing the trusted source track |
| `alignSubtitleToReference` | cue start events vs. a trusted track's events | accepting a target-language subtitle |

A mapping is `time → time * rate + offset`. Only globally consistent corrections are accepted; a subtitle that fits in one part of the film and not another scores low by construction, because scores are aggregated per window/section with a lower-quartile penalty and a coverage factor.

Everything that depends only on the inputs — sorted cue times, per-cue token sets, speech bins, per-window word tokens — is computed once and cached by array identity, because the search evaluates thousands of mappings per candidate and evaluating one must be cheap. Cue ranges are resolved by binary search rather than scanning all cues.

## State on disk

```
data/
├── streams.json          play-link registry (records + last selection per title)
├── rejections.json       variant ids the viewer rejected, per release
└── subtitles/
    ├── <key>.srt         finished subtitle
    └── <key>.json        provider, language, confidence, translated flag
```

All three are written to a unique temporary file and renamed, so a crash cannot leave a half-written entry. Registry writes are serialized through a promise chain; cache writes carry a per-process random suffix. The registry prunes by TTL and record count; the cache is swept by age (`CACHE_TTL_DAYS`).

## Failure policy

- A provider that fails is logged and skipped; the others still run.
- A candidate that fails to download, unpack, decode or align is skipped; the next wave runs.
- Anything below `MINIMUM_CONFIDENCE` is not served. The request fails instead.
- Errors are mapped to statuses a client can act on: 404 expired job, 422 nothing matched, 504 still working, 502 upstream fault.
- Because a player renders none of those to the viewer, the subtitle routes convert them into a readable message track unless `STATUS_MESSAGES=false`.
