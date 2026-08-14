# Translation

Translation is normally the fallback of last resort and only runs when asked for (`TRANSLATION_MODE=manual`, the default). The subtitle menu also exposes an explicit `force AI translation` row. Selecting it always generates an AI version from a validated source-language timing track, even when AutoSub already found a working target-language subtitle. The forced and direct variants are cached separately, so the paid alternative never replaces the normal row. The cheapest translation is still the one that never happens, so use the override deliberately.

A feature film is roughly 1,200–1,600 cues and 60–80k characters. That figure is what every option below should be judged against, and `/stats` reports it per run alongside the tokens actually charged.

## Choosing an engine

| `TRANSLATION_PROVIDER` | What it is | Needs | Cost shape |
|---|---|---|---|
| `gemini` | Google's API, schema-constrained | `TRANSLATION_API_KEY` | per token |
| `openai` | Anything speaking `/v1/chat/completions` | `TRANSLATION_BASE_URL`, `TRANSLATION_MODEL` | whatever that endpoint charges — including nothing |
| `deepl` | Classic machine translation | `TRANSLATION_API_KEY` | per character, with a monthly free allowance |
| `libretranslate` | Self-hosted machine translation | `TRANSLATION_BASE_URL` | free, and yours to run |

The two families behave differently, and the difference matters more than the brand:

**Language models** (`gemini`, `openai`) see a whole batch of cues at once, so they can resolve pronouns, register and running jokes across lines — the things a subtitle fragment cannot carry on its own. They can also drop, merge or renumber cues, which is why every answer is checked against the ids that were sent and rejected outright if anything is missing. Never applied blindly.

**Machine translation** (`deepl`, `libretranslate`) takes an array of strings and returns an array of strings. Position is the contract, so a lost line is impossible to mistake for a translated one, and cost is a simple function of characters. Each line is translated alone, so cross-line context is lost. For subtitles this shows up as flat pronouns and inconsistent forms of address.

## Configuration examples

A router with free models, or any hosted OpenAI-compatible endpoint:

```dotenv
TRANSLATION_PROVIDER=openai
TRANSLATION_BASE_URL=https://openrouter.ai/api/v1
TRANSLATION_API_KEY=sk-...
TRANSLATION_MODEL=some-provider/some-model
```

A private gateway that accepts only `model` and `messages` — some do — needs no
special setting: the first rejected request teaches the client to send the bare
form for the rest of its life.

```dotenv
TRANSLATION_PROVIDER=openai
TRANSLATION_BASE_URL=https://your-gateway.example/v1
TRANSLATION_API_KEY=...
TRANSLATION_MODEL=your-model
TRANSLATION_CONCURRENCY=12
TRANSLATION_TIMEOUT_MS=180000
```

Reasoning models are slow enough to matter here. AutoSub uses verified 120-cue
batches and runs up to twelve at once by default. The private Codex gateway was
benchmarked at 95 successful requests per minute with twelve truly overlapping
executions, so a typical film can be submitted in one or two waves. Other
endpoints may support less: 429 backpressure automatically halves the active
worker count and remembers the working limit without discarding completed paid
batches. A long translation may still exceed `JOB_WAIT_MS`, so the first
request returns the
"still preparing" notice and the subtitle appears when the row is selected
again. Set `TRANSLATION_CONCURRENCY` to what the endpoint allows (1–12).

Language-model batches are intentionally moderate rather than enormous: a
truncated or malformed batch is retried in smaller halves instead of failing
the entire title. Every complete result is also checked for cue identity and
for a model that mostly echoed the source. Arabic prompts explicitly request
concise, natural Modern Standard Arabic with consistent gender, names, tone,
and scene context rather than literal line-by-line wording.

A model running on your own machine, where the only cost is electricity:

```dotenv
TRANSLATION_PROVIDER=openai
TRANSLATION_BASE_URL=http://127.0.0.1:11434/v1
TRANSLATION_MODEL=your-local-model
```

DeepL, whose free tier covers a few titles a month:

```dotenv
TRANSLATION_PROVIDER=deepl
TRANSLATION_API_KEY=xxxxxxxx:fx
```

LibreTranslate on a VPS — no quota, no bill, no third party:

```dotenv
TRANSLATION_PROVIDER=libretranslate
TRANSLATION_BASE_URL=http://your-vps:5000
```

```sh
docker run -d --restart unless-stopped -p 5000:5000 \
  libretranslate/libretranslate --load-only en,ar
```

Restricting the loaded language pairs keeps its memory footprint small. Reach it over a private network or tunnel rather than exposing it publicly.

## What it costs, per title

Watch `/stats` after a translation:

```json
"translation": { "cues": 1431, "characters": 68210, "promptTokens": 41200, "responseTokens": 38700 }
```

`characters` is what a per-character engine bills. `promptTokens` and `responseTokens` are what the model actually charged, reported by the API rather than estimated. Multiply by your provider's current rate — and remember the result is cached per release, so a title is paid for once.

## Switching engines

The cache key includes the provider, model, and whether AI was explicitly forced. Direct and forced subtitles therefore coexist for the same release, while choosing the force row again reuses the already generated result. Nothing needs clearing by hand.

## What never changes

Whichever engine is selected, it receives cue ids and text only. Timestamps stay in this process and are reapplied to the translated text locally, so a translation can affect wording but never the timing that was validated against the audio.
