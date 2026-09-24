# Translation

Translation is the fallback of last resort, and it is automatic: when no Arabic subtitle passes validation, the best validated timing track is translated without the viewer doing anything. That track is the spoken-language subtitle when one matched the transcript; otherwise it is the other-language reference (normally English) that matched the speech activity — which is how a Japanese film with no Japanese subtitles still gets an Arabic one.

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

Reasoning models are slow enough to matter here. Batches are sized so the
whole title goes out in one parallel wave — `ceil(cues / TRANSLATION_CONCURRENCY)`,
between 40 and 120 cues — because a reasoning model's latency grows with the
length of its answer. Each batch also receives the four lines before it as
read-only context, so a scene split across two batches keeps its pronouns and
register. `TRANSLATION_REASONING_EFFORT` (default `medium`) is sent as
`reasoning_effort`. 429 backpressure automatically halves the active worker
count and remembers the working limit without discarding completed paid
batches; a 429 whose `Retry-After` is longer than 30 seconds (an exhausted
subscription) fails the title immediately instead of retrying.

A long translation may still exceed `JOB_WAIT_MS`, so the first request returns
the "still preparing" notice and the subtitle appears when `Arabic` is selected
again. Set `TRANSLATION_CONCURRENCY` to what the endpoint allows (1–12).

Language-model batches are intentionally moderate rather than enormous: a
truncated or malformed batch is retried in smaller halves instead of failing
the entire title. Every complete result is also checked for cue identity and
for a model that mostly echoed the source. Arabic prompts explicitly request
concise, natural Modern Standard Arabic with consistent gender, names, tone,
and scene context rather than literal line-by-line wording.

### The private Codex gateway

The production instance translates with `gpt-6-luna` at `medium` effort through
the Codex subscription gateway on the A1 host, reached over Tailscale rather
than through Cloudflare:

```dotenv
TRANSLATION_PROVIDER=openai
TRANSLATION_BASE_URL=http://a1.tail70e8a6.ts.net:8792/v1
TRANSLATION_MODEL=gpt-6-luna
TRANSLATION_REASONING_EFFORT=medium
TRANSLATION_TIMEOUT_MS=420000
DNS_SERVER=100.100.100.100
```

Cloudflare's proxy closes any request whose response has not started within
100 seconds, and a medium-effort batch can take longer than that, so the public
`openai.jweaker.xyz` hostname is not suitable for this caller. The tailnet name
needs the container to use Tailscale's resolver, hence `DNS_SERVER`. The
gateway's own `COMPAT_REQUEST_TIMEOUT_MS` must stay above
`TRANSLATION_TIMEOUT_MS`.

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

The cache key includes the provider and model, so switching engines regenerates translations on the next play. Nothing needs clearing by hand.

## What never changes

Whichever engine is selected, it receives cue ids and text only. Timestamps stay in this process and are reapplied to the translated text locally, so a translation can affect wording but never the timing that was validated against the audio.
