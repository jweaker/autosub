# Matching and tuning

AutoSub would rather return nothing than return a subtitle that drifts. Every knob below moves that line; the defaults are the tested ones.

## What a confidence score means

Confidence is not a similarity percentage. It combines three independent quantities, then scales the result by how much of the title actually corroborates the match:

- **Signal** — how well the best mapping fits, per window.
- **Uniqueness** — how far that fit stands above the rest of the search space. A subtitle that scores 0.5 everywhere is not a match; a subtitle that scores 0.5 at exactly one offset is.
- **Coverage** — how many independent windows or sections agree. A fit confirmed at 20 minutes and again at 90 minutes is worth far more than a strong fit in one place.

A mapping is rejected outright, whatever it scored, when it:

- lands at the edge of the allowed offset range (`MAX_SYNC_OFFSET_SECONDS`),
- is corroborated by too few windows,
- would push more than a handful of cues before the start of playback, or
- is not meaningfully better than the rest of the search space.

`MINIMUM_CONFIDENCE` is then applied to what survives.

## The three matchers

| Matcher | Evidence | When |
|---|---|---|
| Transcript | cue text vs. transcribed words and their timings | source-language track, when Deepgram transcribed ≥2 windows |
| Activity | cue spans vs. VAD speech bins | fallback when transcription is unavailable |
| Reference | cue start events vs. the trusted track's events | accepting a target-language subtitle |

Only global corrections are applied: `newTime = oldTime × rate + offset`. The coarse sweep covers the frame-rate ratios that cause real drift (23.976↔25, 24↔25, 29.97↔30) plus small clock errors; the fine sweep refines to 50 ms and 0.01%. Per-cue nudging is deliberately not implemented — it can make a mismatched subtitle *look* aligned at every sampled point while being wrong everywhere else.

## Settings

| Variable | Default | Effect |
|---|---|---|
| `MINIMUM_CONFIDENCE` | `58` | The accept/reject line. Raise for stricter results and more failures; lower for more results and more false matches. |
| `MAX_SYNC_OFFSET_SECONDS` | `180` | Largest correction considered. Wider searches take longer and admit more coincidental fits. |
| `CANDIDATE_LIMIT` | `10` | Candidates downloaded and validated per language. Costs provider quota and time. |
| `AUDIO_SAMPLE_COUNT` | `4` | Windows sampled across the title. More windows means stronger coverage and more bandwidth. |
| `AUDIO_SAMPLE_SECONDS` | `15` | Length of each window. |
| `AUDIO_CONCURRENCY` | `4` | Samples fetched at once. Remote range seeks dominate cold-start latency. |
| `REFERENCE_LANGUAGES` | *(empty)* | Extra languages allowed to serve as the trusted timing track. |

Change one thing at a time and re-test against several real releases. `npm run smoke -- tt1234567` prints the provider, confidence, cue count and first timestamps for a live run.

## Symptoms and what they mean

**Subtitles are consistently a fixed amount late or early.** The chosen track was validated, so the offset is inside tolerance but not zero. Check the logged `midpointOffsetMs`; if it is large and the result still looks wrong, the wrong candidate won — raise `MINIMUM_CONFIDENCE`.

**Nothing is ever returned for a title.** Look at the log line from the audio analysis. Few or zero transcripts usually means an unusual audio codec, a mislabelled track, or no Deepgram key. `REFERENCE_LANGUAGES` can help when the original language has thin subtitle coverage.

**Everything is translated even though target-language subtitles exist.** They were downloaded and rejected: their cue events did not match the trusted track. That is often correct — different cut, different release. Lower `MINIMUM_CONFIDENCE` only after checking a few by hand.

**A delivered subtitle is wrong even though it passed.** Pick "AutoSub: try another" in the subtitle menu. That records the file as rejected for this release forever and prepares the next best candidate, reusing the audio analysis. If it happens repeatedly on titles of the same kind, raise `MINIMUM_CONFIDENCE`; the rejections tell you where the current threshold is too generous.

**Cold runs are slow.** Audio sampling dominates, and it is bounded by the debrid host's seek latency. Reduce `AUDIO_SAMPLE_SECONDS` or `AUDIO_SAMPLE_COUNT` before touching anything else; both weaken coverage, so watch for false matches afterwards.
