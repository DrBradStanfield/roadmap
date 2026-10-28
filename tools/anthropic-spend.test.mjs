import { describe, it, expect } from 'vitest';
import {
  centsToUsd, monthRange, previousMonth, aggregateCost, aggregateUsage, keyNameMap, toCsv, csvField,
  summarize, totalUsd, fetchAll, main, parseArgs, CONSOLE_KEY,
} from './anthropic-spend.mjs';

const costPage = (results, extra = {}) => ({ data: [{ starting_at: 'a', ending_at: 'b', results }], has_more: false, ...extra });
const COST = [
  costPage([
    { amount: '250.5', model: 'claude-sonnet-5-5', token_type: 'uncached_input_tokens', cost_type: 'tokens', currency: 'USD', extra: 1 },
    { amount: '100', model: 'claude-opus-5-5', token_type: 'output_tokens', cost_type: 'tokens' },
  ]),
  costPage([{ amount: '50', model: 'claude-sonnet-5-5', token_type: 'uncached_input_tokens', cost_type: 'tokens' }, { amount: 'oops' }]),
];
const USAGE = [
  costPage([
    { api_key_id: 'k1', model: 'm1', uncached_input_tokens: 10, cache_read_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 3 }, output_tokens: 20 },
    { api_key_id: null, model: 'm1', uncached_input_tokens: 100, output_tokens: 1 },
    { api_key_id: 'k_gone', model: 'm2', output_tokens: 7 },
  ]),
  costPage([{ api_key_id: 'k1', model: 'm1', output_tokens: 5 }]),
];
const KEYS = [{ data: [{ id: 'k1', name: 'prod, "main"', partial_key_hint: 'sk-ant-...x' }] }, { data: [{ id: 'k2', name: 'other' }] }];

describe('aggregation', () => {
  it('converts cents to USD', () => {
    expect(centsToUsd('250.5')).toBeCloseTo(2.505);
    expect(centsToUsd(undefined)).toBe(0);
  });
  it('sums cost by model/token/cost type, sorted desc, tolerates junk', () => {
    const rows = aggregateCost(COST);
    expect(rows.map((r) => r.model)).toEqual(['claude-sonnet-5-5', 'claude-opus-5-5', 'unknown']);
    expect(rows[0].usd).toBeCloseTo(3.005);
    expect(totalUsd(rows)).toBeCloseTo(4.005);
  });
  it('maps key ids, console null, unknown id; sums tokens; sorts desc', () => {
    const rows = aggregateUsage(USAGE, keyNameMap(KEYS));
    expect(rows[0]).toEqual({ api_key: CONSOLE_KEY, model: 'm1', tokens: 101 });
    expect(rows.find((r) => r.api_key === 'k_gone').tokens).toBe(7);
    expect(rows.find((r) => r.api_key === 'prod, "main"').tokens).toBe(10 + 5 + 2 + 3 + 20 + 5);
  });
  it('keyNameMap keeps only id and name', () => {
    expect([...keyNameMap(KEYS).entries()]).toEqual([['k1', 'prod, "main"'], ['k2', 'other']]);
  });
});

describe('csv', () => {
  it('escapes commas and quotes', () => {
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('plain')).toBe('plain');
  });
  it('writes header, month column and blank usd on usage rows', () => {
    const csv = toCsv('2026-09', aggregateCost(COST), aggregateUsage(USAGE, keyNameMap(KEYS))).split('\n');
    expect(csv[0]).toBe('month,kind,api_key,model,token_type,cost_type,usd,tokens');
    expect(csv[1]).toBe('2026-09,cost,,claude-sonnet-5-5,uncached_input_tokens,tokens,3.0050,');
    expect(csv.find((l) => l.includes('"prod, ""main"""'))).toBe('2026-09,usage,"prod, ""main""",m1,,,,45');
  });
});

describe('dates and summary', () => {
  it('computes ranges', () => {
    expect(monthRange('2026-09', new Date('2026-10-26T00:00:00Z'))).toEqual({ start: '2026-09-01T00:00:00Z', end: '2026-10-01T00:00:00Z' });
    expect(monthRange('2026-10', new Date('2026-10-26T12:30:00.123Z')).end).toBe('2026-10-26T12:30:00Z');
    expect(() => monthRange('2026-13')).toThrow();
    expect(previousMonth('2026-01')).toBe('2025-12');
  });
  it('defaults args', () => {
    expect(parseArgs([], new Date('2026-10-05T00:00:00Z'))).toEqual({ month: '2026-10', out: 'docs/ops/anthropic-spend/2026-10.csv', compare: false });
  });
  it('shows compare delta', () => {
    const s = summarize({ month: '2026-09', costRows: [{ model: 'm', token_type: '', cost_type: '', usd: 150 }], usageRows: [], previous: { month: '2026-08', usd: 100 } });
    expect(s).toContain('Total: **$150.00**');
    expect(s).toContain('change 50.0%');
    expect(s.split('\n').length).toBeLessThan(30);
  });
});

const jsonRes = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe('fetchAll', () => {
  it('follows next_page and sends headers', async () => {
    const calls = [];
    const f = async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1 ? jsonRes({ data: [1], has_more: true, next_page: 'tok' }) : jsonRes({ data: [2], has_more: false });
    };
    const pages = await fetchAll(f, 'KEY', '/v1/organizations/api_keys', [['limit', '100']]);
    expect(pages).toHaveLength(2);
    expect(calls[1].url).toContain('page=tok');
    expect(calls[0].init.headers['x-api-key']).toBe('KEY');
    expect(calls[0].init.headers['anthropic-version']).toBe('2023-06-01');
  });
});

describe('main', () => {
  const quiet = () => { const out = { log: [], err: [], files: {} }; return { out, deps: { log: (s) => out.log.push(s), err: (s) => out.err.push(s), write: (p, c) => { out.files[p] = c; }, mkdir: () => {}, now: new Date('2026-10-26T00:00:00Z') } }; };
  it('exits 2 without a key', async () => {
    const { out, deps } = quiet();
    expect(await main([], {}, deps)).toBe(2);
    expect(out.err[0]).toContain('ANTHROPIC_ADMIN_KEY');
  });
  it('prints only status and error.type on HTTP errors', async () => {
    const { out, deps } = quiet();
    const f = async () => jsonRes({ error: { type: 'permission_error', message: 'SECRET DETAIL' } }, 403);
    expect(await main(['--month', '2026-09'], { ANTHROPIC_ADMIN_KEY: 'k' }, { ...deps, fetchImpl: f })).toBe(1);
    expect(out.err.join()).toContain('403');
    expect(out.err.join()).toContain('permission_error');
    expect(out.err.join()).not.toContain('SECRET');
  });
  it('runs end to end with compare', async () => {
    const { out, deps } = quiet();
    const f = async (url) => {
      if (url.includes('cost_report')) return jsonRes(COST[0]);
      if (url.includes('usage_report')) return jsonRes(USAGE[0]);
      return jsonRes(KEYS[0]);
    };
    expect(await main(['--month', '2026-09', '--compare', '--out', 'x/y.csv'], { ANTHROPIC_ADMIN_KEY: 'k' }, { ...deps, fetchImpl: f })).toBe(0);
    expect(out.files['x/y.csv']).toContain('2026-09,cost');
    expect(out.log[0]).toContain('Previous (2026-08)');
  });
});
