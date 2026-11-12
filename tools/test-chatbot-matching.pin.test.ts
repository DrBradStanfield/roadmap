/**
 * Golden pins for tools/test-chatbot-matching.ts before it is split (a pure move). The harness is a paid
 * CLI with no exports, so these pin what it prints, the request shapes it sends and its exit codes. It runs
 * as a subprocess with `fetch` stubbed and tools/test-queries.json replaced by SYNTHETIC fixtures, against a
 * synthetic three-entry index: no call leaves the machine, and no real key is passed. Elapsed time,
 * latency, dollar figures and the temp folder are normalised. Plus its (empty) export list, read with the TypeScript checker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { REPO_ROOT, tsxSpawn } from './test-helpers';

const HARNESS = 'tools/test-chatbot-matching.ts';

const INDEX = [
  { title: 'Pin A', handle: 'pin-a', url: 'https://example.com/a', type: 'article', summary: 'Synthetic summary A.' },
  { title: 'Pin B', handle: 'pin-b', url: 'https://example.com/b', type: 'guideline', summary: 'Synthetic summary B.' },
  { title: 'Pin C', handle: 'pin-c', url: 'https://example.com/c', type: 'reference', summary: 'Synthetic summary C.' },
];

const FIXTURES = [
  { query: 'q-pass', category: 'pin', expected: ['pin-a'], must_mention: ['alpha'], notes: 'a synthetic note' },
  { query: 'q-miss', category: 'pin', expected: ['pin-b'] },
  { query: 'q-forbid', category: 'pin', expected: ['pin-a'], must_not_route: ['pin-c'] },
  { query: 'q-empty', category: 'pin', expected: [] },
  { query: 'q-repair', category: 'pin', expected: ['pin-b'] },
  { query: 'q-parse', category: 'pin', expected: ['pin-a'] },
  { query: 'q-500', category: 'pin', expected: ['pin-a'] },
  { query: 'q-429', category: 'pin', expected: ['pin-a'] },
  {
    query: 'q-answer-fail', category: 'pin', expected: ['pin-a'], must_not_mention: ['beta'], must_not_claim: ['lowers blood pressure'],
    must_match: ['gamma'], must_not_match: ['delta'], max_length_chars: 20,
  },
  { query: 'q-refusal', category: 'pin', expected: ['pin-a'], must_mention: ['x'] },
  { query: 'q-answer-timeout', category: 'pin', expected: ['pin-a'], must_mention: ['x'] },
  { query: 'q-answer-429', category: 'pin', expected: ['pin-a'], must_mention: ['ok'] },
  { query: 'q-pending', category: 'pin', expected: ['pin-a'], pending: 'waits on content' },
  { query: 'q-fixed', category: 'pin2', surface: 'doctor', answer_handles: [], must_mention: ['ok'] },
  { query: 'q-context', category: 'pin2', surface: 'doctor', answer_handles: [], user_context: {}, expect_roadmap_run: false, must_mention: ['ok'] },
  {
    query: 'q-history', category: 'pin2', surface: 'brand', answer_handles: [], must_mention: ['ok'],
    history: [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }],
  },
  { query: 'q-other', category: 'other', expected: ['pin-a'] },
];

const ROUTER: Record<string, unknown> = {
  'q-pass': '{"handles":["pin-a"]}', 'q-miss': '{"handles":[]}', 'q-forbid': '{"handles":["pin-a","pin-c"]}',
  'q-empty': '{"handles":[]}', 'q-repair': 'Here: {"handles":["guideline-pin-b"]}', 'q-parse': 'no json here',
  'q-500': { status: 500, body: 'synthetic outage' }, 'q-429': { status: 429, once: true },
};
const ANSWER: Record<string, unknown> = {
  'q-pass': 'Alpha answer.', 'q-answer-fail': 'Beta. It lowers blood pressure. delta delta delta.',
  'q-refusal': { refusal: true }, 'q-answer-timeout': { timeout: true }, 'q-answer-429': { status: 429, once: true },
};

let dir: string;
const runs: Record<string, { status: number | null; out: string; err: string; calls: unknown[] }> = {};

const norm = (s: string) => s
  .replace(/\x1b\[[0-9;]*m/g, '')
  .replace(/=== Results \([0-9.]+s\) ===/, '=== Results (<T>s) ===')
  .replace(/p50=\d+ms p90=\d+ms/g, 'p50=<T>ms p90=<T>ms')
  .replace(/\$\d+\.\d+/g, '$<N>')
  .split(REPO_ROOT).join('<ROOT>')
  .replace(/\S*chatbot-matching-pin-\w+/g, '<DIR>');

function harness(name: string, flags: string[], opts: { fixtures?: object[]; key?: boolean; cwd?: string } = {}) {
  const sub = join(dir, name);
  const log = join(sub, 'calls.jsonl');
  writeFileSync(join(dir, `${name}.mjs`), `
    import fs from 'node:fs';
    const read = fs.readFileSync;
    const fixtures = ${JSON.stringify(JSON.stringify(opts.fixtures ?? FIXTURES))};
    fs.readFileSync = (p, ...rest) => String(p).endsWith('tools/test-queries.json') ? fixtures : read(p, ...rest);
    const ROUTER = ${JSON.stringify(ROUTER)}, ANSWER = ${JSON.stringify(ANSWER)};
    const seen = new Map();
    const ok = (text, extra = {}) => new Response(JSON.stringify({
      content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, ...extra,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const sys = (s) => typeof s === 'string'
      ? { kind: 'string', refs: s.includes('## Referenced Blog Articles'), user: s.includes('## Current User Health Data') }
      : { kind: 'blocks', n: s.length, cached: s.map(b => !!b.cache_control), user: s.some(b => b.text.includes('## Current User Health Data')) };
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'https://api.anthropic.com/v1/messages') throw new Error('unexpected fetch ' + url);
      const body = JSON.parse(init.body);
      const first = body.messages[0].content;
      const router = typeof first === 'string' && first.startsWith('Current query: ');
      const query = router ? first.slice(15) : body.messages.filter(m => m.role === 'user' && typeof m.content === 'string').at(-1).content;
      const n = (seen.get((router ? 'r:' : 'a:') + query) ?? 0) + 1;
      seen.set((router ? 'r:' : 'a:') + query, n);
      fs.mkdirSync(${JSON.stringify(sub)}, { recursive: true });
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(router
        ? { router: query, blocks: body.system.length, cached: body.system.map(b => !!b.cache_control),
            count: body.system[0].text.includes('a 3-entry index'), index: body.system[1].text }
        : { answer: query, system: sys(body.system), roles: body.messages.map(m => m.role), tools: (body.tools ?? []).map(t => t.name) }) + '\\n');
      const plan = (router ? ROUTER : ANSWER)[query];
      if (plan && typeof plan === 'object') {
        if (plan.status && (!plan.once || n === 1)) return new Response(plan.body ?? '', { status: plan.status, headers: { 'retry-after': '0' } });
        if (plan.timeout) throw new DOMException('timed out', 'TimeoutError');
        if (plan.refusal) return ok('', { stop_reason: 'refusal', stop_details: { category: 'bio' } });
      }
      if (router) return ok(typeof plan === 'string' ? plan : '{"handles":["pin-a"]}');
      return ok(typeof plan === 'string' ? plan : 'ok');
    };
  `);
  const [bin, args] = tsxSpawn(['--import', join(dir, `${name}.mjs`), join(REPO_ROOT, HARNESS), ...flags]);
  const { ANTHROPIC_API_KEY: _live, ANTHROPIC_TEST_API_KEY: _test, TOPIC_MASTER_HIDE: _flag, ...rest } = process.env; // never a real key
  const env = opts.key === false ? rest : { ...rest, ANTHROPIC_TEST_API_KEY: 'stub' };
  const res = spawnSync(bin, args, { cwd: opts.cwd ?? REPO_ROOT, env, encoding: 'utf-8', timeout: 100_000 });
  if (res.error) throw res.error;
  let calls: unknown[] = [];
  try { calls = readFileSync(log, 'utf-8').trim().split('\n').map(l => JSON.parse(l)); } catch { /* no call made */ }
  runs[name] = { status: res.status, out: norm(res.stdout), err: norm(res.stderr), calls };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'chatbot-matching-pin-'));
  const index = join(dir, 'index.json');
  writeFileSync(index, JSON.stringify(INDEX));
  const base = ['--index', index, '--model', 'claude-sonnet-5-5', '--answer-model', 'claude-sonnet-5-5'];
  harness('full', [...base, '--category', 'pin,pin2', '--runs', '2', '--answer-check', '--answer-check-runs', '1', '--verbose']);
  harness('routerOnly', [...base, '--category', 'pin', '--runs', '1']);
  harness('fixedOnly', [...base, '--category', 'pin,pin2', '--fixed-handles-only', '--answer-check-runs', '3', '--include-pending']);
  harness('estimate', [...base, '--category', 'pin,pin2', '--answer-check', '--estimate'], { key: false });
  const bad = (name: string, fixture: object, flags: string[] = []) =>
    harness(name, [...base, '--category', 'v', ...flags], { fixtures: [{ query: name, category: 'v', ...fixture }] });
  bad('badForbidden', { expected: ['pin-a'], must_not_route: ['nope'] });
  bad('badRegex', { expected: ['pin-a'], must_match: ['('] });
  bad('badHistory', { expected: ['pin-a'], history: [{ role: 'assistant', content: 'x' }] });
  bad('badProfile', { expected: ['pin-a'], expect_profile_edit: {} });
  bad('badContext', { answer_handles: [], user_context: {}, must_mention: ['ok'] }, ['--answer-check']);
  bad('badFixed', { answer_handles: ['no-such-handle'], must_mention: ['ok'] }, ['--answer-check']);
  harness('noMatch', [...base, '--category', 'nothing-here']);
  harness('noKey', [...base, '--category', 'pin'], { key: false });
  harness('wrongCwd', [...base, '--category', 'pin'], { cwd: dir });
}, 600_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('test-chatbot-matching golden pins (pre-split)', () => {
  it('exports nothing (a CLI)', () => {
    const file = join(REPO_ROOT, HARNESS);
    const program = ts.createProgram([file], { allowJs: true, noEmit: true, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 });
    const sym = program.getTypeChecker().getSymbolAtLocation(program.getSourceFile(file)!);
    const names = sym ? program.getTypeChecker().getExportsOfModule(sym).map(s => s.name).sort() : [];
    expect(names).toMatchSnapshot();
  });

  it('a full router and answer-check run: report, request shapes, exit code', () => {
    const r = runs.full;
    expect(r.out, r.err).toContain('=== LLM Router Test Harness ===');
    expect(r.out).toContain('Pending (skipped; --include-pending runs them): 1');
    expect(r.calls.some(c => (c as { router?: string }).router === 'q-other')).toBe(false);
    expect(r.status).toBe(1);
    expect(r).toMatchSnapshot();
  });

  it('a router-only run makes no answer call', () => {
    const r = runs.routerOnly;
    expect(r.calls.every(c => 'router' in (c as object)), r.err).toBe(true);
    expect(r).toMatchSnapshot();
  });

  it('--fixed-handles-only runs only the fixed-handle checks and gates on them', () => {
    const r = runs.fixedOnly;
    expect(r.calls.every(c => 'answer' in (c as object)), r.err).toBe(true);
    expect(r).toMatchSnapshot();
  });

  it('--estimate prices the run, needs no key and makes no call', () => {
    const r = runs.estimate;
    expect(r.out, r.err).toContain('No API call made.');
    expect(r.calls).toEqual([]);
    expect(r).toMatchSnapshot();
  });

  it('invalid fixtures, no match, no key and the wrong folder each exit before any call', () => {
    const names = ['badForbidden', 'badRegex', 'badHistory', 'badProfile', 'badContext', 'badFixed', 'noMatch', 'noKey', 'wrongCwd'];
    for (const n of names) {
      expect(runs[n].calls, n).toEqual([]);
      expect(runs[n].status, `${n}: ${runs[n].err}`).toBe(1);
    }
    expect(Object.fromEntries(names.map(n => [n, runs[n]]))).toMatchSnapshot();
  });
});
