#!/usr/bin/env node
// Monthly Anthropic spend: which model and which API key cost money.
// Reads the Usage and Cost Admin API (needs ANTHROPIC_ADMIN_KEY). No model, no dependencies.
// Spec and CI wiring: docs/ops/anthropic-spend.md
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE = 'https://api.anthropic.com';
export const CSV_HEADER = 'month,kind,api_key,model,token_type,cost_type,usd,tokens';
export const CONSOLE_KEY = 'console/playground';

export class ApiError extends Error {
  constructor(status, type) {
    super(`HTTP ${status} (${type})`);
    this.status = status;
    this.type = type;
  }
}

const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
};

/** Cost-report amounts are decimal strings in cents. */
export const centsToUsd = (cents) => num(cents) / 100;

export function monthRange(month, now = new Date()) {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month ?? '');
  if (!m) throw new Error(`Bad --month "${month}", expected YYYY-MM`);
  const y = +m[1], mo = +m[2];
  const start = new Date(Date.UTC(y, mo - 1, 1));
  const next = new Date(Date.UTC(y, mo, 1));
  const end = next > now ? now : next;
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { start: iso(start), end: iso(end) };
}

export function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const flatten = (pages) => pages.flatMap((p) => (p?.data ?? []).flatMap((b) => b?.results ?? []));

/** Sum cost results by model / token_type / cost_type. Returns rows sorted by usd desc. */
export function aggregateCost(pages) {
  const acc = new Map();
  for (const r of flatten(pages)) {
    const row = {
      model: r.model || 'unknown',
      token_type: r.token_type || '',
      cost_type: r.cost_type || '',
    };
    const k = [row.model, row.token_type, row.cost_type].join('\u0000');
    const cur = acc.get(k) ?? { ...row, usd: 0 };
    cur.usd += centsToUsd(r.amount);
    acc.set(k, cur);
  }
  return [...acc.values()].sort((a, b) => b.usd - a.usd);
}

export const totalUsd = (rows) => rows.reduce((s, r) => s + r.usd, 0);

const tokenSum = (r) =>
  num(r.uncached_input_tokens) +
  num(r.cache_read_input_tokens) +
  num(r.cache_creation?.ephemeral_5m_input_tokens) +
  num(r.cache_creation?.ephemeral_1h_input_tokens) +
  num(r.output_tokens);

/** Map api key id to name from api_keys pages. Only id and name are kept. */
export function keyNameMap(pages) {
  const map = new Map();
  for (const p of pages) for (const k of p?.data ?? []) if (k?.id) map.set(k.id, k.name || k.id);
  return map;
}

/** Sum usage tokens per key name x model. Null key id is the console; unknown id shows the id. */
export function aggregateUsage(pages, names) {
  const acc = new Map();
  for (const r of flatten(pages)) {
    const api_key = r.api_key_id == null ? CONSOLE_KEY : (names.get(r.api_key_id) ?? r.api_key_id);
    const model = r.model || 'unknown';
    const k = api_key + '\u0000' + model;
    const cur = acc.get(k) ?? { api_key, model, tokens: 0 };
    cur.tokens += tokenSum(r);
    acc.set(k, cur);
  }
  return [...acc.values()].sort((a, b) => b.tokens - a.tokens);
}

export const csvField = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const usdStr = (n) => n.toFixed(4);

export function toCsv(month, costRows, usageRows) {
  const lines = [CSV_HEADER];
  for (const r of costRows)
    lines.push(['cost', '', r.model, r.token_type, r.cost_type, usdStr(r.usd), ''].map(csvField).join(','));
  for (const r of usageRows)
    lines.push(['usage', r.api_key, r.model, '', '', '', r.tokens].map(csvField).join(','));
  return lines.map((l, i) => (i === 0 ? l : `${csvField(month)},${l}`)).join('\n') + '\n';
}

const usd = (n) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function summarize({ month, costRows, usageRows, previous }) {
  const total = totalUsd(costRows);
  const byModel = new Map();
  for (const r of costRows) byModel.set(r.model, (byModel.get(r.model) ?? 0) + r.usd);
  const byKey = new Map();
  for (const r of usageRows) byKey.set(r.api_key, (byKey.get(r.api_key) ?? 0) + r.tokens);
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const out = [`## Anthropic spend ${month}`, '', `Total: **${usd(total)}**`];
  if (previous) {
    const pct = previous.usd > 0 ? `${(((total - previous.usd) / previous.usd) * 100).toFixed(1)}%` : 'n/a';
    out.push(`Previous (${previous.month}): ${usd(previous.usd)}, change ${pct}`);
  }
  out.push('', '### Top models by cost', '', '| Model | USD |', '|---|---|');
  for (const [k, v] of top(byModel)) out.push(`| ${k} | ${usd(v)} |`);
  out.push('', '### Top API keys by tokens', '', '| API key | Tokens |', '|---|---|');
  for (const [k, v] of top(byKey)) out.push(`| ${k} | ${v.toLocaleString('en-US')} |`);
  return out.join('\n') + '\n';
}

export function parseArgs(argv, now = new Date()) {
  const o = { month: null, out: null, compare: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--month') o.month = argv[++i];
    else if (argv[i] === '--out') o.out = argv[++i];
    else if (argv[i] === '--compare') o.compare = true;
    else throw new Error(`Unknown argument "${argv[i]}"`);
  }
  o.month ??= now.toISOString().slice(0, 7);
  o.out ??= `docs/ops/anthropic-spend/${o.month}.csv`;
  return o;
}

/** GET a paginated endpoint; returns the list of pages. Errors carry status and error.type only. */
export async function fetchAll(fetchImpl, key, path, params) {
  const pages = [];
  let page;
  do {
    const qs = new URLSearchParams();
    for (const [k, v] of params) qs.append(k, v);
    if (page) qs.set('page', page);
    const res = await fetchImpl(`${BASE}${path}?${qs}`, {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'user-agent': 'health-roadmap-spend/1',
      },
    });
    if (!res.ok) {
      let type = 'unknown';
      try {
        const t = (await res.json())?.error?.type;
        if (typeof t === 'string') type = t;
      } catch { /* body is not JSON */ }
      throw new ApiError(res.status, type);
    }
    const body = await res.json();
    pages.push(body);
    page = body?.has_more ? body.next_page : undefined;
  } while (page);
  return pages;
}

const costParams = (r) => [
  ['starting_at', r.start], ['ending_at', r.end], ['group_by[]', 'description'], ['limit', '31'],
];
const usageParams = (r) => [
  ['starting_at', r.start], ['ending_at', r.end], ['bucket_width', '1d'],
  ['group_by[]', 'api_key_id'], ['group_by[]', 'model'], ['limit', '31'],
];

export async function main(argv, env = process.env, deps = {}) {
  const { fetchImpl = fetch, write = writeFileSync, mkdir = mkdirSync, log = console.log, err = console.error, now = new Date() } = deps;
  const key = env.ANTHROPIC_ADMIN_KEY;
  if (!key) {
    err('ANTHROPIC_ADMIN_KEY is not set. Add it as a GitHub Actions secret; see docs/ops/anthropic-spend.md.');
    return 2;
  }
  let args;
  try {
    args = parseArgs(argv, now);
    const range = monthRange(args.month, now);
    const [costPages, usagePages, keyPages] = [
      await fetchAll(fetchImpl, key, '/v1/organizations/cost_report', costParams(range)),
      await fetchAll(fetchImpl, key, '/v1/organizations/usage_report/messages', usageParams(range)),
      await fetchAll(fetchImpl, key, '/v1/organizations/api_keys', [['limit', '100']]),
    ];
    const costRows = aggregateCost(costPages);
    const usageRows = aggregateUsage(usagePages, keyNameMap(keyPages));
    let previous;
    if (args.compare) {
      const pm = previousMonth(args.month);
      const prev = await fetchAll(fetchImpl, key, '/v1/organizations/cost_report', costParams(monthRange(pm, now)));
      previous = { month: pm, usd: totalUsd(aggregateCost(prev)) };
    }
    mkdir(dirname(args.out), { recursive: true });
    write(args.out, toCsv(args.month, costRows, usageRows));
    log(summarize({ month: args.month, costRows, usageRows, previous }));
    return 0;
  } catch (e) {
    if (e instanceof ApiError) err(`Anthropic API error: HTTP ${e.status}, ${e.type}`);
    else err(String(e?.message ?? e));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
