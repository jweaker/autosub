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
| `translation/` | Pluggable translation backends behind one interface |
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

GET /:token/next/:jobId[/:attempt].srt
    ├─ RejectionStore.add         (this release will never serve that file again)
    ├─ JobManager.start           (same release, larger exclusion set)
    └─ the replacement subtitle
```

The attempt number carries no meaning beyond making each retry row a distinct
URL: players do not re-request a track they have already loaded, so a single
shared URL could only be used once per playback.

The subtitle list is requested *before* or *around* the play redirect depending on the client, which is why `waitFor` exists: it blocks briefly on the registry rather than returning an empty list.

## The pipeline

`AutoSubPipeline.complete()` runs the expensive path once per release and language:

1. **Cache probe.** The key covers the media fingerprint, target language, rejection set, translation model, and whether the viewer explicitly forced AI. Direct and generated variants therefore coexist, and every rejection generation caches separately.
2. **Parallel start.** Audio analysis and provider searches are launched together; the searches for the source language do not wait for the probe.
3. **Source validation.** Candidates in the original language are aligned against the transcript (`alignSubtitleToTranscript`). The winner becomes the *trusted timing track*.
4. **Target validation.** Candidates in the target language are aligned against that trusted track (`alignSubtitleToReference`). A match is served directly, with the lower of the two confidences.
5. **Language-independent fallback.** If no subtitle in the spoken language can carry the timing, a subtitle in another language is validated against speech activity and used as the reference instead; failing that — and only when no timing track was trusted at all — the target is checked against speech activity directly. Once a track has been trusted, a target it rejected is not re-tried against weaker evidence: asking a lesser witness until one agrees is how a subtitle nobody vouched for reaches the screen. Speech activity does not care what language a subtitle is written in, which is what makes this possible — and it is weaker evidence, so both routes answer to `ACTIVITY_MINIMUM_CONFIDENCE`.
6. **Strict audio recovery.** A trusted reference normally wins over weaker activity evidence. The exception is a target with both very high activity confidence and strong release-name evidence, because the reference itself may be a different edit. This narrow gate recovers known-release remux subtitles without admitting generic dense tracks.
7. **Translation or explicit override.** If nothing matches, the configured engine translates the trusted track only when policy or the viewer allows it. Selecting the dedicated force row skips target-language candidate evaluation and translates the first audio-validated source track even when a direct result is already cached. It sees cue ids and text only. Independent batches run concurrently; a malformed large response is retried in smaller pieces.
8. **Settle and stabilize.** Whatever route produced the subtitle, it is measured against the speech in the sampled audio; because that measurement is signed, it is also the correction, so a track that inherited an error from its reference is pulled back onto the dialogue and only refused if it still misses by more than 1200 ms. Duplicate, one-frame, and tiny-overlap cues are removed or repaired so correct text does not flicker in the player.
9. **Store.** Success is written to the cache; a cache write failure costs time on the next play but never fails the request.

Each result carries a variant id — `provider:providerId`, or that id prefixed with `translated:` for a translation — plus a content fingerprint. A rejection bars both the id and identical content published under another provider id. Rejecting a translation bars its source track, because reusing that track would produce the same translation again. Audio probes are kept in memory per release, so a rejection-driven re-run skips ffmpeg entirely and finishes in seconds.

Candidates are downloaded in waves of up to three, giving distinct providers first choice and then filling unused seats by rank. A borderline match triggers one extra wave so it cannot hide a much stronger file immediately behind it. The first target wave starts downloading while the source track is still being validated. A provider that reports a long quota cooldown is paused for that period instead of being retried for every candidate.

Every run records the wall-clock cost of each stage, failure reason, exclusion count, candidate counts, best rejected confidence, and cue cleanup; `/stats` reports the last 25. Audio analysis dominates a cold run, so its length adapts to the release: sampling reads the interleaved container, and `AUDIO_BUDGET_MB` caps how much of it one analysis may pull.

## Alignment

Three related searches share one machine (`searchMapping`): a coarse sweep over common frame-rate ratios and offsets, then a fine sweep around the winner.

| Function | Compares | Used for |
|---|---|---|
| `alignSubtitle` | cue spans vs. VAD speech bins | fallback when transcription is unavailable |
| `alignSubtitleToTranscript` | cue text vs. transcribed words, plus activity | choosing the trusted source track |
| `alignSubtitleToReference` | cue start events vs. a trusted track's events | accepting a target-language subtitle |

The coarse sweep charges a rate deviation against the score it earns, because sampled windows constrain the offset far better than the rate: a stretch only moves cues between windows, where a dense subtitle always has another to offer, so an unpriced search invents frame-rate conversions and picks a different one each run. Each search is followed by a refinement step, because the two questions differ: the score says which subtitle matches, but it is flat across the padding between a cue and the speech inside it, so it cannot say where within that plateau the truth lies. Cue starts are anchored to the transcribed words that belong to them (or to speech onsets when nothing transcribed), and the median residual shifts the mapping into convention. It is bounded and has a dead band, so it polishes rather than re-aligns.

A mapping is `time → time * rate + offset`. Only globally consistent corrections are accepted; a subtitle that fits in one part of the film and not another scores low by construction, because scores are aggregated per window/section with a lower-quartile penalty and a coverage factor.

Everything that depends only on the inputs — sorted cue times, per-cue token sets, speech bins, per-window word tokens — is computed once and cached by array identity. Fine alignment uses coordinate refinement plus a small joint grid for ordinary clock errors, while genuine frame-rate conversions retain an exhaustive fine search. Cue ranges are resolved by binary search rather than scanning all cues.

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
