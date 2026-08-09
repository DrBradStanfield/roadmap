#!/usr/bin/env node
/**
 * Fleet dashboard generator — renders docs/loops/ data (REGISTRY.md,
 * per-loop metrics.csv/ledger.csv, charter line counts, latest reports)
 * into one static, dependency-free HTML page.
 *
 * Published by pages.yml → https://drbradstanfield.github.io/roadmap/fleet.html
 * (rebuilt on every push that touches docs/loops/**). Never committed:
 * pure presentation over the repo's CSVs — the repo stays the source of truth.
 *
 * Usage: node scripts/build-fleet-dashboard.mjs [out.html]
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const LOOPS = path.join(ROOT, 'docs', 'loops');
const OUT = process.argv[2] || path.join(ROOT, 'fleet.html');
const REPO = 'DrBradStanfield/roadmap';
const BLOB = `https://github.com/${REPO}/blob/main/docs/loops`;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- tiny CSV parser (quoted fields, no embedded newlines) ---
function parseCsv(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

// --- registry table -> loop list ---
const registry = readFileSync(path.join(LOOPS, 'REGISTRY.md'), 'utf8');
const loops = [];
for (const line of registry.split('\n')) {
  const m = line.match(/^\|\s*([^|]+?)\s*\|\s*\[?([^\]|]*)\]?[^|]*\|\s*`([^`]+)`\s*\(([^)]*)\)\s*\|[^|]*\|[^|]*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/);
  if (!m || m[1] === 'Loop' || m[1].startsWith('---')) continue;
  loops.push({ name: m[1], cron: m[3], schedule: m[4], signal: m[5], status: m[6] });
}

function loopDir(name) {
  const slug = name.replace(/\s*\(external\).*/, '');
  const dir = path.join(LOOPS, slug);
  return existsSync(dir) ? { slug, dir } : null;
}

const lineCount = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split('\n').length : null);

function sparkline(vals) {
  const nums = vals.map(Number).filter((v) => Number.isFinite(v));
  if (nums.length < 2) return '';
  const max = Math.max(...nums), min = Math.min(...nums), span = max - min || 1;
  const pts = nums.map((v, i) => `${(i / (nums.length - 1)) * 60},${18 - ((v - min) / span) * 16}`).join(' ');
  return `<svg class="spark" viewBox="0 0 60 20" width="60" height="20" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

function metricsSection(dir) {
  const p = path.join(dir, 'metrics.csv');
  if (!existsSync(p)) return '<p class="dim">No metrics.csv yet.</p>';
  const rows = parseCsv(readFileSync(p, 'utf8'));
  if (!rows.length) return '<p class="dim">metrics.csv is empty.</p>';
  // Latest row per metric wins within a week (loops append superseding rows).
  const byMetric = new Map();
  for (const r of rows) {
    if (!byMetric.has(r.metric)) byMetric.set(r.metric, []);
    const series = byMetric.get(r.metric);
    if (series.length && series[series.length - 1].week === r.week) series[series.length - 1] = r;
    else series.push(r);
  }
  let html = '<table><tr><th>metric</th><th>latest</th><th>Δ%</th><th>trend</th></tr>';
  for (const [metric, series] of byMetric) {
    const last = series[series.length - 1];
    const delta = last.delta_pct !== '' && last.delta_pct != null ? `${last.delta_pct}%` : '—';
    const cls = String(last.delta_pct).startsWith('-') ? 'down' : (last.delta_pct ? 'up' : '');
    html += `<tr><td>${esc(metric)}</td><td>${esc(last.count_7d)}</td><td class="${cls}">${esc(delta)}</td><td>${sparkline(series.map((s) => s.count_7d))}</td></tr>`;
  }
  return html + '</table>';
}

function ledgerSection(dir) {
  const p = path.join(dir, 'ledger.csv');
  if (!existsSync(p)) return '';
  const rows = parseCsv(readFileSync(p, 'utf8'));
  const counts = {};
  for (const r of rows) counts[r.status || '?'] = (counts[r.status || '?'] || 0) + 1;
  const parts = Object.entries(counts).map(([k, v]) => `${v} ${esc(k)}`).join(' · ');
  return `<p><strong>Ledger:</strong> ${rows.length} issue${rows.length === 1 ? '' : 's'}${parts ? ` (${parts})` : ''}</p>`;
}

function latestReport(dir, slug) {
  const reports = readdirSync(dir).filter((f) => /^\d{4}-W\d{2}\.md$/.test(f)).sort();
  if (!reports.length) return '<span class="dim">no report yet</span>';
  const f = reports[reports.length - 1];
  return `<a href="${BLOB}/${slug}/${encodeURIComponent(f)}">${esc(f)}</a>`;
}

function vitals(dir) {
  const parts = [];
  for (const f of ['LOOP.md', 'LEARNINGS.md']) {
    const n = lineCount(path.join(dir, f));
    if (n == null) continue;
    const pct = Math.min(100, Math.round((n / 200) * 100));
    const warn = n >= 180 ? ' warn' : '';
    parts.push(`<div class="vital${warn}"><span>${f} ${n}/200</span><div class="bar"><i style="width:${pct}%"></i></div></div>`);
  }
  return parts.join('');
}

// --- open PRs + attention issues (best-effort; offline-safe) ---
async function ghJson(url) {
  try {
    const headers = { 'User-Agent': 'fleet-dashboard', Accept: 'application/vnd.github+json' };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

const [issues, prs] = await Promise.all([
  ghJson(`https://api.github.com/repos/${REPO}/issues?state=open&per_page=30`),
  ghJson(`https://api.github.com/repos/${REPO}/pulls?state=open&per_page=20`),
]);

function attentionSection() {
  if (!issues && !prs) return '<p class="dim">GitHub API unreachable at build time.</p>';
  const items = [];
  for (const i of issues ?? []) {
    if (i.pull_request) continue;
    if (/^(🎯|🚀|🕒|🚨)/u.test(i.title)) items.push(`<li><a href="${i.html_url}">#${i.number} ${esc(i.title)}</a></li>`);
  }
  for (const p of prs ?? []) {
    if (p.head?.ref?.startsWith('claude/')) items.push(`<li>PR <a href="${p.html_url}">#${p.number} ${esc(p.title)}</a> <span class="dim">(in ship pipeline)</span></li>`);
  }
  return items.length ? `<ul>${items.join('')}</ul>` : '<p class="dim">Nothing needs attention. 🎉</p>';
}

let built = 'unknown';
try { built = execSync('git log -1 --format=%cI', { cwd: ROOT }).toString().trim(); } catch { /* shallow/no git */ }

const cards = loops.map((l) => {
  const d = loopDir(l.name);
  return `<section class="card">
    <h2>${esc(l.name)}</h2>
    <p class="dim">${esc(l.schedule)} · <code>${esc(l.cron)}</code></p>
    <p>${esc(l.status)}</p>
    <p><strong>Signal:</strong> ${esc(l.signal)}</p>
    ${d ? `<p><strong>Latest report:</strong> ${latestReport(d.dir, d.slug)}</p>${vitals(d.dir)}${ledgerSection(d.dir)}${metricsSection(d.dir)}` : '<p class="dim">External loop — data lives in claude_business.</p>'}
  </section>`;
}).join('\n');

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Roadmap Fleet</title>
<style>
:root { color-scheme: light dark; --fg:#1a1a1a; --bg:#fff; --dim:#777; --line:#e2e2e2; --card:#fafafa; --up:#137a2d; --down:#b3261e; --warn:#8a5a00; }
@media (prefers-color-scheme: dark) { :root { --fg:#e8e8e8; --bg:#111; --dim:#999; --line:#333; --card:#1b1b1b; --up:#5dd47f; --down:#ff7b72; --warn:#e8b34a; } }
body { margin:0 auto; max-width:760px; padding:16px; font:15px/1.5 -apple-system,system-ui,sans-serif; color:var(--fg); background:var(--bg); }
h1 { font-size:1.3em; margin:.2em 0; } h2 { font-size:1.05em; margin:0 0 .3em; }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:14px 0; overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:.92em; } th,td { text-align:left; padding:3px 8px 3px 0; border-bottom:1px solid var(--line); } th { color:var(--dim); font-weight:500; }
.dim { color:var(--dim); } .up { color:var(--up); } .down { color:var(--down); }
.spark { color:var(--dim); vertical-align:middle; }
.vital { display:flex; align-items:center; gap:8px; font-size:.85em; color:var(--dim); margin:2px 0; }
.vital.warn { color:var(--warn); }
.bar { flex:1; max-width:140px; height:6px; background:var(--line); border-radius:3px; } .bar i { display:block; height:100%; background:currentColor; border-radius:3px; }
code { font-size:.9em; } a { color:inherit; } ul { padding-left:1.2em; margin:.3em 0; }
footer { color:var(--dim); font-size:.85em; margin:20px 0; }
</style></head><body>
<h1>🛰️ Roadmap Fleet</h1>
<p class="dim">Autonomous-loop status · data from <a href="https://github.com/${REPO}/tree/main/docs/loops">docs/loops/</a> · rebuilt on every loop commit</p>
<section class="card"><h2>Needs attention</h2>${attentionSection()}</section>
${cards}
<footer>Last data commit: ${esc(built)} · generated by scripts/build-fleet-dashboard.mjs · dashboard is presentation only — the repo is the source of truth</footer>
</body></html>`;

writeFileSync(OUT, html);
console.log(`fleet dashboard → ${OUT} (${statSync(OUT).size} bytes, ${loops.length} loops)`);
