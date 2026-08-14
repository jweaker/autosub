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

### Why a good match still needs a second look

A cue is not a speech span. Subtitles appear shortly before their line and stay
on screen after it, so the speech sits *inside* a wider cue. Overlap scoring is
therefore flat across that padding — every offset within it scores the same —
and the search alone will settle anywhere in that plateau. That is exactly what
"validated, high confidence, and still slightly out of sync" looks like, and
the wider the cues, the worse it gets.

So identification and estimation are separated. The search decides *which*
subtitle fits; speech onsets then decide *where* it sits. Each cue is anchored
to the first transcribed word that belongs to it (or, with no transcript, to
the nearest speech onset), and the median of those residuals shifts the whole
mapping so cues lead their speech by the usual small margin. The correction is
skipped entirely when the evidence disagrees by less than 250 ms — inside
subtitling convention and below what a viewer notices — and is capped, so it
can polish a mapping but never re-align the title.

### Why a rate change has to pay for itself

Four sampled windows cover about a minute of a two-hour film. That pins the
offset well and the rate barely at all: a shift moves every cue in every window,
while a four per cent stretch only moves cues *between* windows, where a dense
subtitle always has another cue to offer. Left to the raw score, the search
invents frame-rate conversions — and invents different ones on different runs of
the same title, which is what "in sync at the start, seconds out by the end"
looks like.

So a rate deviation is charged against the score it earns, at three points of
score per unit of rate. A real conversion pays that easily, because at the wrong
rate a subtitle is tens of seconds out by the far end of the film. A guess that
merely fits a minute of sampled audio does not. Exact ties then go to the
smaller shift, so the answer never depends on which placement the search
happened to visit first.

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
| `AUDIO_BUDGET_MB` | `240` | Ceiling on bytes one analysis may download. The main cold-run speed control. |
| `REFERENCE_LANGUAGES` | *(empty)* | Extra languages allowed to serve as the trusted timing track. |

Change one thing at a time and re-test against several real releases. `npm run smoke -- tt1234567` prints the provider, confidence, cue count and first timestamps for a live run.

## Symptoms and what they mean

**Subtitles are consistently a fixed amount late or early.** The chosen track was validated, so the offset is inside tolerance but not zero. Check the logged `midpointOffsetMs`; if it is large and the result still looks wrong, the wrong candidate won — raise `MINIMUM_CONFIDENCE`.

**Nothing is ever returned for a title.** Look at the log line from the audio analysis. Few or zero transcripts usually means an unusual audio codec, a mislabelled track, or no Deepgram key.

**A title falls back to `audio`.** That route only runs when no timing track in any language could be trusted, because speech activity cannot overrule a rejection by stronger evidence. Seeing it means the title had no usable reference at all.

**Everything about a title goes through the fallback route.** Check `route` in `/stats`: `source` means a subtitle in the spoken language carried the timing, `reference` means another language did, `audio` means the target was matched against speech activity alone. A film whose original language has few subtitles — anime, most non-English cinema — will legitimately sit on `reference`. If it sits on `audio` often, add languages to `FALLBACK_REFERENCE_LANGUAGES`, because a whole-title event match is much stronger evidence than four sampled windows.

**Everything is translated even though target-language subtitles exist.** They were downloaded and rejected: their cue events did not match the trusted track. That is often correct — different cut, different release. Lower `MINIMUM_CONFIDENCE` only after checking a few by hand.

**A delivered subtitle is wrong even though it passed.** Pick `Arabic - Next` in the subtitle menu. That records the file as rejected for this release forever and prepares the next best candidate, reusing the audio analysis. If it happens repeatedly on titles of the same kind, raise `MINIMUM_CONFIDENCE`; the rejections tell you where the current threshold is too generous.

**Cold runs are slow.** Check `/stats` first — `audio` almost always dominates, and it is bandwidth rather than CPU. Sampling reads the interleaved container, not just the audio track, so a window costs `bitrate x seconds` regardless of how little audio is in it: fifteen seconds of a 100 Mbit remux is ~190 MB, the same fifteen seconds of an 8 Mbit web release is ~15 MB.

`AUDIO_BUDGET_MB` (default 240) caps the total. Windows are shortened automatically to fit it, never below 8s, so heavy releases pay in coverage instead of in minutes. Lowering it to 120 roughly halves the download on those releases; raising it favours validation strength. `AUDIO_SAMPLE_COUNT` and `AUDIO_SAMPLE_SECONDS` remain the upper bounds for ordinary releases.
