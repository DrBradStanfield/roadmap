#!/usr/bin/env node
// Weekly PR cycle time (PR opened -> merged) for the product-health loop's metrics.csv.
// Read-only: `gh pr list`, or a JSON file of PRs (gh or REST/MCP shape). No dependencies.
//   node tools/pr-cycle-time.mjs                       7d window ending now (the loop's run)
//   node tools/pr-cycle-time.mjs --end 2026-11-14T20:47:00Z
//   node tools/pr-cycle-time.mjs --file prs.json [--end ...]
// Cycle time runs from createdAt, so a long draft or a closed-then-reopened PR counts its whole
// life: the note names how many merged PRs were open over 7 days and the longest, never drops them.
// Bot-authored PRs and generated engine-release PRs are left out of the stats and counted in the note.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ENGINE_RELEASE = /^Engine release \d{12}\b/;
// GitHub search (behind `gh pr list --search`) returns at most 1000 results, whatever --limit says.
const GH_LIMIT = 1000;

/** gh (`createdAt`, `author.is_bot`) and REST/MCP (`created_at`, `user.type`) shapes, one shape out. */
export function normalizePr(p) {
  const author = p.author ?? p.user ?? {};
  const login = author.login ?? '';
  return {
    number: p.number,
    title: p.title ?? '',
    createdAt: Date.parse(p.createdAt ?? p.created_at),
    mergedAt: Date.parse(p.mergedAt ?? p.merged_at),
    bot: author.is_bot === true || author.type === 'Bot' || login.endsWith('[bot]'),
  };
}

/** ISO 8601 week label (`2026-W46`) of a UTC instant. */
export function isoWeekLabel(ms) {
  const d = new Date(ms);
  const day = d.getUTCDay() || 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day);
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export function median(sorted) {
  if (!sorted.length) return 0;
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

/** Nearest-rank p90: the smallest value with at least 90% of the list at or below it. */
export function p90(sorted) {
  return sorted.length ? sorted[Math.ceil(0.9 * sorted.length) - 1] : 0;
}

const round1 = (n) => Math.round(n * 10) / 10;

function windowStats(prs, start, end) {
  const merged = prs.filter((p) => p.mergedAt >= start && p.mergedAt < end);
  const counted = merged.filter((p) => !p.bot && !ENGINE_RELEASE.test(p.title));
  const hours = counted.map((p) => (p.mergedAt - p.createdAt) / HOUR).sort((a, b) => a - b);
  return {
    merged: counted.length,
    excluded: merged.length - counted.length,
    medianH: round1(median(hours)),
    p90H: round1(p90(hours)),
    over7d: hours.filter((h) => h > 7 * 24).length,
    maxH: round1(hours.at(-1) ?? 0),
  };
}

/** Cycle-time stats for [end-7d, end) and the prior 7 days; `end` is exclusive. */
export function cycleTime(prs, end) {
  const all = prs.map(normalizePr).filter((p) => Number.isFinite(p.mergedAt) && Number.isFinite(p.createdAt));
  return {
    week: isoWeekLabel(end - 1),
    current: windowStats(all, end - 7 * DAY, end),
    prior: windowStats(all, end - 14 * DAY, end - 7 * DAY),
  };
}

/** metrics.csv convention: whole-number percent, blank when the prior week is 0. */
export function deltaPct(cur, prior) {
  return prior ? String(Math.round(((cur - prior) / prior) * 100)) : '';
}

const csvQuote = (s) => `"${s.replace(/"/g, '""')}"`;

/** Rows in metrics.csv format (week,metric,count_7d,count_prior_7d,delta_pct,source,note). */
export function toRows({ week, current: c, prior: p }) {
  const empty = c.merged ? '' : 'no merged PRs; ';
  const tail = `${c.excluded} bot/engine-release PRs left out`;
  const long = `${c.over7d} open >7d, longest ${c.maxH}h`;
  const row = (metric, cur, prior, note) =>
    [week, metric, cur, prior, deltaPct(cur, prior), 'github', csvQuote(note)].join(',');
  return [
    row('prs_merged', c.merged, p.merged, `opened->merged, PRs merged in the 7d window; ${tail}`),
    row('pr_cycle_time_median_h', c.medianH, p.medianH, `${empty}${long}`),
    row('pr_cycle_time_p90_h', c.p90H, p.p90H, `${empty}nearest-rank p90; ${long}`),
  ];
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Merged PRs from gh, one query per 7d window with a day of margin each side (each stays under the
 *  search cap), deduped by number; cycleTime() trims to the exact windows. */
export function fetchWithGh(end, run = execFileSync) {
  const byNumber = new Map();
  for (const winEnd of [end, end - 7 * DAY]) {
    const search = `merged:${ymd(winEnd - 8 * DAY)}..${ymd(winEnd + DAY)}`;
    const out = run('gh', ['pr', 'list', '--state', 'merged', '--search', search,
      '--json', 'number,title,createdAt,mergedAt,author', '--limit', String(GH_LIMIT)], { encoding: 'utf8' });
    const prs = JSON.parse(out);
    if (prs.length >= GH_LIMIT) throw new Error(`gh returned ${prs.length} PRs for ${search}, the search cap: counts would be cut short`);
    for (const p of prs) byNumber.set(p.number, p);
  }
  return [...byNumber.values()];
}

export function main(argv = process.argv.slice(2), { now = Date.now(), fetch = fetchWithGh } = {}) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const end = arg('--end') ? Date.parse(arg('--end')) : now;
  if (!Number.isFinite(end)) throw new Error(`Bad --end "${arg('--end')}", expected an ISO date`);
  const file = arg('--file');
  const prs = file ? JSON.parse(readFileSync(file, 'utf8')) : fetch(end);
  return toRows(cycleTime(prs, end)).join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  console.log(main());
}
