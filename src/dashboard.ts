import type { CachedSubtitleInfo } from "./cache.js";
import type { AppConfig } from "./config.js";
import type { RunSummary } from "./pipeline.js";

export interface DashboardData {
  config: AppConfig;
  runs: RunSummary[];
  cache: CachedSubtitleInfo[];
  providers: string[];
  jobs: { tracked: number; running: number };
  uptimeSeconds: number;
  basePath: string;
  csrfToken: string;
  query?: string;
  cleared?: number;
}

const escapeHtml = (value: unknown): string => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const number = (value: number): string => new Intl.NumberFormat("en-US").format(Math.round(value));
const percent = (value: number): string => `${Math.round(value * 100)}%`;
const duration = (milliseconds: number): string => {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
};
const seconds = (value: number): string => value < 60 ? `${value.toFixed(1)} s` : `${(value / 60).toFixed(1)} min`;
const bytes = (value: number): string => {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
};
const date = (value: string): string => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Unknown" : parsed.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
};

function metric(label: string, value: string, detail: string): string {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></div>`;
}

function outcomeLabel(run: RunSummary): string {
  if (run.outcome === "cached") return "Cache hit";
  if (run.outcome === "translated") return "AI translated";
  if (run.outcome === "direct") return "Direct match";
  return "Failed";
}

export function renderDashboard(data: DashboardData): string {
  const { config, runs, providers, jobs, basePath, csrfToken } = data;
  const successes = runs.filter((run) => run.outcome !== "failed");
  const failures = runs.filter((run) => run.outcome === "failed");
  const translated = runs.filter((run) => run.outcome === "translated" && run.translation);
  const direct = runs.filter((run) => run.outcome === "direct");
  const cached = runs.filter((run) => run.outcome === "cached");
  const prepared = runs.filter((run) => run.outcome !== "cached");
  const averageRunMs = prepared.length ? prepared.reduce((total, run) => total + run.totalMs, 0) / prepared.length : 0;
  const promptTokens = translated.reduce((total, run) => total + (run.translation?.promptTokens || 0), 0);
  const responseTokens = translated.reduce((total, run) => total + (run.translation?.responseTokens || 0), 0);
  const translatedCharacters = translated.reduce((total, run) => total + (run.translation?.characters || 0), 0);
  const translatedCues = translated.reduce((total, run) => total + (run.translation?.cues || 0), 0);
  const translationMs = translated.reduce((total, run) => total + (run.stages.translate || 0), 0);
  const audioRuns = runs.filter((run) => run.audio);
  const deepgramSeconds = audioRuns.reduce((total, run) => total + (run.audio?.deepgramSeconds || 0), 0);
  const deepgramRequests = audioRuns.reduce((total, run) => total + (run.audio?.deepgramRequests || 0), 0);
  const sampledSeconds = audioRuns.reduce((total, run) => total + (run.audio?.sampledSeconds || 0), 0);
  const transcripts = audioRuns.reduce((total, run) => total + (run.audio?.transcripts || 0), 0);
  const reusedProbes = audioRuns.filter((run) => run.audio?.reused).length;
  const cacheBytes = data.cache.reduce((total, entry) => total + entry.bytes, 0);
  const query = (data.query || "").trim().toLocaleLowerCase();
  const matchingCache = data.cache.filter((entry) => !query || [entry.contentId, entry.release, entry.provider, entry.id]
    .some((value) => value?.toLocaleLowerCase().includes(query)));
  const visibleCache = matchingCache.slice(0, 200);

  const failureGroups = new Map<string, number>();
  for (const run of failures) {
    const reason = run.failure || "No failure detail recorded";
    failureGroups.set(reason, (failureGroups.get(reason) || 0) + 1);
  }
  const failureRows = [...failureGroups]
    .sort((left, right) => right[1] - left[1])
    .map(([reason, count]) => `<li><strong>${number(count)}</strong><span>${escapeHtml(reason)}</span></li>`)
    .join("");

  const runRows = runs.map((run) => `<tr>
    <td><span class="state state-${run.outcome}">${outcomeLabel(run)}</span></td>
    <td><strong>${escapeHtml(run.contentId)}</strong><small title="${escapeHtml(run.release)}">${escapeHtml(run.release || "Release unavailable")}</small></td>
    <td>${escapeHtml(run.provider || "-")}<small>${escapeHtml(run.route || "-")}</small></td>
    <td class="numeric">${run.confidence == null ? "-" : `${run.confidence}%`}</td>
    <td class="numeric">${duration(run.totalMs)}</td>
    <td><time datetime="${escapeHtml(run.at)}">${escapeHtml(date(run.at))}</time></td>
  </tr>`).join("");

  const cacheRows = visibleCache.map((entry) => `<tr>
    <td class="select"><input aria-label="Select ${escapeHtml(entry.contentId || entry.id)}" type="checkbox" name="key" value="${entry.key}"></td>
    <td><strong>${escapeHtml(entry.contentId || "Legacy entry")}</strong><small title="${escapeHtml(entry.release)}">${escapeHtml(entry.release || entry.id)}</small></td>
    <td>${escapeHtml(entry.provider)}<small>${entry.translated ? `AI from ${escapeHtml(entry.sourceLanguage || "source")}` : "Direct subtitle"}</small></td>
    <td class="numeric">${escapeHtml(entry.language)} / ${entry.confidence}%</td>
    <td class="numeric">${bytes(entry.bytes)}</td>
    <td><time datetime="${escapeHtml(entry.cachedAt)}">${escapeHtml(date(entry.cachedAt))}</time></td>
  </tr>`).join("");

  const notice = data.cleared == null ? "" : `<div class="notice" role="status">Removed ${number(data.cleared)} cache ${data.cleared === 1 ? "entry" : "entries"}.</div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>AutoSub operations</title>
<style>
:root{color-scheme:light;--bg:#f3f5f4;--surface:#e9eeec;--line:#cbd5d1;--text:#17211d;--muted:#52635c;--accent:#0f766e;--accent-ink:#f2fbf8;--danger:#b42318;--ok:#16794c;--radius:12px;--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111714;--surface:#18211d;--line:#34433d;--text:#edf4f1;--muted:#a4b4ad;--accent:#5eead4;--accent-ink:#10201c;--danger:#ff8a80;--ok:#6ee7a8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-size:14px;line-height:1.45}a{color:var(--accent);text-underline-offset:3px}button,input{font:inherit}button{border:0;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-weight:750;padding:.7rem 1rem;cursor:pointer;white-space:nowrap}button:active{transform:translateY(1px)}button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 55%,transparent);outline-offset:2px}.shell{width:min(1480px,100%);margin:auto;padding:0 24px 64px}.topbar{min-height:68px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);gap:24px}.brand{font-size:18px;font-weight:800;color:var(--text);text-decoration:none;letter-spacing:-.02em}.nav{display:flex;gap:18px;align-items:center;white-space:nowrap}.nav a{color:var(--muted);text-decoration:none}.nav a[aria-current]{color:var(--text);font-weight:700}.intro{padding:42px 0 28px;display:grid;grid-template-columns:minmax(0,2fr) minmax(220px,1fr);gap:32px;align-items:end}.intro h1{font-size:clamp(32px,5vw,58px);line-height:.98;letter-spacing:-.055em;margin:0 0 14px;max-width:760px}.intro p{color:var(--muted);margin:0;max-width:62ch;font-size:16px}.service{border-left:3px solid var(--ok);padding:4px 0 4px 18px}.service strong,.service span{display:block}.service strong{font-size:18px}.service span{color:var(--muted);margin-top:4px}.notice{margin:0 0 20px;padding:12px 16px;border:1px solid var(--accent);border-radius:var(--radius);background:color-mix(in srgb,var(--accent) 8%,var(--bg));font-weight:700}.metrics{display:grid;grid-template-columns:1.4fr repeat(3,1fr);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;background:var(--surface);margin-bottom:20px}.metric{padding:18px 20px;border-right:1px solid var(--line);min-width:0}.metric:last-child{border:0}.metric span,.metric small{display:block;color:var(--muted)}.metric strong{display:block;font:750 clamp(24px,4vw,38px)/1 var(--mono);letter-spacing:-.05em;margin:12px 0 8px}.grid{display:grid;grid-template-columns:1.15fr .85fr;gap:20px;margin:20px 0}.panel{border:1px solid var(--line);border-radius:var(--radius);padding:22px;background:var(--surface);min-width:0}.panel h2{font-size:20px;margin:0 0 6px;letter-spacing:-.025em}.panel>p{color:var(--muted);margin:0 0 20px}.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.fact span,.fact small{display:block;color:var(--muted)}.fact strong{display:block;font:700 22px/1.2 var(--mono);margin:5px 0}.failures{list-style:none;padding:0;margin:0;display:grid;gap:10px}.failures li{display:grid;grid-template-columns:38px 1fr;gap:10px;align-items:start}.failures strong{font-family:var(--mono);color:var(--danger)}.section{margin-top:28px}.section-head{display:flex;align-items:end;justify-content:space-between;gap:18px;margin-bottom:12px}.section h2{font-size:24px;letter-spacing:-.035em;margin:0}.section-head p{margin:4px 0 0;color:var(--muted)}.filter{display:flex;gap:8px;align-items:end}.field{display:grid;gap:5px}.field label{font-size:12px;color:var(--muted);font-weight:700}.field input[type=search]{min-width:280px;border:1px solid var(--line);border-radius:8px;padding:.65rem .75rem;background:var(--surface);color:var(--text)}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}table{border-collapse:collapse;width:100%;min-width:860px}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}th{font-size:11px;color:var(--muted);letter-spacing:.06em;text-transform:uppercase}td strong,td small{display:block}td small{color:var(--muted);max-width:440px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}.numeric{font-family:var(--mono);font-variant-numeric:tabular-nums}.state{font-size:12px;font-weight:750}.state-direct,.state-translated{color:var(--ok)}.state-failed{color:var(--danger)}.state-cached{color:var(--accent)}.select{width:42px}.select input{width:17px;height:17px;accent-color:var(--accent)}.cache-actions{display:flex;justify-content:flex-end;align-items:center;gap:16px;margin-top:12px}.confirm{display:flex;align-items:center;gap:8px;color:var(--muted)}.confirm input{width:17px;height:17px;accent-color:var(--danger)}.danger{background:var(--danger);color:#fff7f5}.empty{padding:36px;text-align:center;color:var(--muted)}footer{color:var(--muted);padding-top:32px}.mono{font-family:var(--mono)}
@media(max-width:800px){.shell{padding:0 14px 40px}.topbar{align-items:flex-start;padding:18px 0;flex-direction:column;gap:10px}.nav{width:100%;overflow:auto;padding-bottom:2px}.intro{grid-template-columns:1fr;padding:30px 0 22px}.metrics{grid-template-columns:repeat(2,1fr)}.metric:nth-child(2){border-right:0}.metric:nth-child(-n+2){border-bottom:1px solid var(--line)}.grid{grid-template-columns:1fr}.section-head{align-items:stretch;flex-direction:column}.filter{align-items:stretch}.field input[type=search]{min-width:0;width:100%}.cache-actions{align-items:stretch;flex-direction:column}.cache-actions button{width:100%}}
</style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <a class="brand" href="${basePath}/dashboard">AutoSub operations</a>
    <nav class="nav" aria-label="Operator navigation">
      <a href="${basePath}/dashboard" aria-current="page">Dashboard</a>
      <a href="${basePath}/stats">JSON stats</a>
      <a href="${basePath}/configure">Install</a>
    </nav>
  </header>
  <main>
    <section class="intro">
      <div><h1>Subtitle reliability, in one place.</h1><p>Recent outcomes, paid AI usage, speech-analysis volume, failure causes, and precise cache controls.</p></div>
      <div class="service"><strong>Service operational</strong><span>${number(jobs.running)} running jobs, ${escapeHtml(providers.join(", ") || "no providers")}</span><span>Uptime ${seconds(data.uptimeSeconds)}</span></div>
    </section>
    ${notice}
    <section class="metrics" aria-label="Run summary">
      ${metric("Success rate", runs.length ? percent(successes.length / runs.length) : "No data", `${number(successes.length)} of ${number(runs.length)} recent runs`)}
      ${metric("Prepared", number(direct.length + translated.length), `${number(cached.length)} cache hits`)}
      ${metric("Failures", number(failures.length), runs.length ? `${percent(failures.length / runs.length)} of recent runs` : "No runs recorded")}
      ${metric("Average cold run", prepared.length ? duration(averageRunMs) : "No data", `${number(prepared.length)} uncached attempts`)}
    </section>
    <div class="grid">
      <section class="panel">
        <h2>AI translation usage</h2>
        <p>${escapeHtml(config.translation.provider)} / ${escapeHtml(config.translation.model)}, up to ${number(config.translation.concurrency)} parallel workers with automatic backpressure, ${escapeHtml(config.translationMode)} mode.</p>
        <div class="facts">
          <div class="fact"><span>Generated titles</span><strong>${number(translated.length)}</strong><small>${number(translatedCues)} cues</small></div>
          <div class="fact"><span>Translation time</span><strong>${translationMs ? duration(translationMs) : "0 s"}</strong><small>Model stage total</small></div>
          <div class="fact"><span>Prompt tokens</span><strong>${number(promptTokens)}</strong><small>Reported by provider</small></div>
          <div class="fact"><span>Response tokens</span><strong>${number(responseTokens)}</strong><small>${number(translatedCharacters)} source characters</small></div>
        </div>
      </section>
      <section class="panel">
        <h2>Voice analysis usage</h2>
        <p>${config.deepgram.apiKey ? "Deepgram is enabled. Submitted audio is measured at request time." : "Deepgram is disabled. Audio validation uses local speech activity."}</p>
        <div class="facts">
          <div class="fact"><span>Deepgram audio</span><strong>${seconds(deepgramSeconds)}</strong><small>${number(deepgramRequests)} requests</small></div>
          <div class="fact"><span>Audio sampled</span><strong>${seconds(sampledSeconds)}</strong><small>${number(transcripts)} transcripts returned</small></div>
          <div class="fact"><span>Probe reuse</span><strong>${number(reusedProbes)}</strong><small>No repeated voice charge</small></div>
          <div class="fact"><span>Tracked jobs</span><strong>${number(jobs.tracked)}</strong><small>${number(jobs.running)} currently running</small></div>
        </div>
      </section>
    </div>
    <section class="panel">
      <h2>Failure causes</h2>
      <p>Grouped from the latest ${number(runs.length)} retained runs.</p>
      ${failureRows ? `<ol class="failures">${failureRows}</ol>` : `<div class="empty">No failures in retained history.</div>`}
    </section>
    <section class="section">
      <div class="section-head"><div><h2>Latest runs</h2><p>Newest first. JSON remains available for automation.</p></div></div>
      <div class="table-wrap">${runRows ? `<table><thead><tr><th>Outcome</th><th>Title and release</th><th>Provider</th><th>Confidence</th><th>Elapsed</th><th>Started</th></tr></thead><tbody>${runRows}</tbody></table>` : `<div class="empty">Play a title to populate run history.</div>`}</div>
    </section>
    <section class="section" id="cache">
      <div class="section-head">
        <div><h2>Subtitle cache</h2><p>${number(data.cache.length)} entries using ${bytes(cacheBytes)}. Select only entries you want regenerated.</p></div>
        <form class="filter" method="get" action="${basePath}/dashboard">
          <div class="field"><label for="cache-query">Filter title, release, or provider</label><input id="cache-query" name="q" type="search" value="${escapeHtml(data.query || "")}"></div>
          <button type="submit">Filter</button>
        </form>
      </div>
      <form method="post" action="${basePath}/admin/cache">
        <input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
        <div class="table-wrap">${cacheRows ? `<table><thead><tr><th>Select</th><th>Title and release</th><th>Origin</th><th>Language</th><th>Size</th><th>Cached</th></tr></thead><tbody>${cacheRows}</tbody></table>` : `<div class="empty">${query ? "No cache entries match this filter." : "The subtitle cache is empty."}</div>`}</div>
        ${cacheRows ? `<div class="cache-actions"><label class="confirm"><input type="checkbox" name="confirm" value="yes" required> I understand these subtitles will be regenerated.</label><button class="danger" type="submit">Delete selected</button></div>` : ""}
      </form>
      ${matchingCache.length > visibleCache.length ? `<p class="mono">Showing the newest ${number(visibleCache.length)} of ${number(matchingCache.length)} matching entries. Refine the filter to find older entries.</p>` : ""}
    </section>
  </main>
  <footer>This page is protected by your private installation token. Do not share its URL.</footer>
</div>
</body>
</html>`;
}
