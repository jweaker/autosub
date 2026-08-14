const [contentId, releaseFragment] = process.argv.slice(2);
if (!contentId) throw new Error("Usage: node --env-file=.env scripts/live-smoke.mjs IMDB_ID [RELEASE_FRAGMENT]");
const base = process.env.PUBLIC_URL?.replace(/\/$/, "");
const token = process.env.INSTALL_TOKEN;
if (!base || !token) throw new Error("PUBLIC_URL and INSTALL_TOKEN are required");

const started = Date.now();
const streamResponse = await fetch(`${base}/${token}/stream/movie/${encodeURIComponent(contentId)}.json`);
if (!streamResponse.ok) throw new Error(`stream endpoint returned ${streamResponse.status}`);
const streamBody = await streamResponse.json();
const streams = Array.isArray(streamBody.streams) ? streamBody.streams : [];
if (!streams.length) throw new Error("No debrid streams returned");
if (releaseFragment === "--list") {
  console.log(streams.slice(0, 60).map((stream, index) => `${index}: ${stream.behaviorHints?.filename || stream.title || "unnamed"}`).join("\n"));
  process.exit(0);
}
const selected = releaseFragment
  ? streams.find((stream) => String(stream.behaviorHints?.filename || stream.title || "").toLowerCase().includes(releaseFragment.toLowerCase()))
  : streams[0];
if (!selected?.url) throw new Error(`Requested release was not found among ${streams.length} streams`);
const play = await fetch(selected.url, { redirect: "manual" });
await play.body?.cancel();
if (play.status !== 302) throw new Error(`play endpoint returned ${play.status}`);

const list = await fetch(`${base}/${token}/subtitles/movie/${encodeURIComponent(contentId)}.json`);
const listBody = await list.json();
const subtitle = listBody.subtitles?.[0];
if (!subtitle?.url) throw new Error("No AutoSub subtitle was listed");
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 180_000);
const response = await fetch(subtitle.url, { signal: controller.signal });
clearTimeout(timer);
const content = await response.text();
const starts = [...content.matchAll(/(?:^|\n)(\d{2}):(\d{2}):(\d{2}),(\d{3}) -->/g)]
  .map((match) => (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4]));
console.log(JSON.stringify({
  status: response.status,
  release: selected.behaviorHints?.filename || selected.title || "unnamed",
  elapsedMs: Date.now() - started,
  provider: response.headers.get("x-autosub-provider"),
  confidence: response.headers.get("x-autosub-confidence"),
  cues: starts.length,
  zeroStarts: starts.filter((value) => value === 0).length,
  firstStartsMs: starts.slice(0, 6),
  lastStartMs: starts.at(-1),
  error: response.ok ? undefined : content.slice(0, 200),
}, null, 2));
if (!response.ok) process.exitCode = 1;
