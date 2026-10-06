/**
 * US-15 AC13 — an answer-check timeout counts as an API error.
 *
 * The harness is a paid script, so it runs here as a real subprocess with
 * `fetch` stubbed: no call leaves the machine. With three answer runs and a
 * majority vote, one timeout and two passes still pass the case, so only the
 * error count keeps the run from exiting green.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, tsxSpawn } from './test-helpers';
import { loadBlogArticle } from '../app/lib/matched-content';

interface Case { category: string; expected: string[]; must_mention?: string[] }

// A category holding exactly one routed case with a must_mention list, so the run is one case.
function pickCase(): Case {
  const all = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/test-queries.json'), 'utf-8')) as Case[];
  const routed = all.filter(q => Array.isArray(q.expected));
  const found = routed.find(q => q.expected.length > 0 && q.must_mention?.length
    && routed.filter(r => r.category === q.category).length === 1);
  if (!found) throw new Error('no single-case category with must_mention in test-queries.json');
  return found;
}

describe('test-chatbot-matching --answer-check (US-15 AC13)', () => {
  it('counts an answer-check timeout in apiErrors and exits non-zero', () => {
    const q = pickCase();
    const dir = mkdtempSync(join(tmpdir(), 'chatbot-matching-'));
    try {
      const stub = join(dir, 'fetch-stub.mjs');
      // Router calls send `system` as an array; answer calls send a string.
      writeFileSync(stub, `
        let answerCalls = 0;
        const ok = (text) => new Response(JSON.stringify({
          content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
        globalThis.fetch = async (_url, init) => {
          const body = JSON.parse(init.body);
          if (Array.isArray(body.system)) return ok(${JSON.stringify(JSON.stringify({ handles: [q.expected[0]] }))});
          answerCalls++;
          if (answerCalls === 2) throw new DOMException('timed out', 'TimeoutError');
          return ok(${JSON.stringify(q.must_mention!.join(' '))});
        };
      `);
      const [bin, args] = tsxSpawn(['--import', stub, 'tools/test-chatbot-matching.ts',
        '--category', q.category, '--answer-check', '--runs', '3']);
      const { ANTHROPIC_API_KEY: _live, ...rest } = process.env; // never a real key: no call leaves the machine
      const env = { ...rest, ANTHROPIC_TEST_API_KEY: 'stub' };
      const res = spawnSync(bin, args, { cwd: REPO_ROOT, env, encoding: 'utf-8', timeout: 60_000 });
      const out = res.stdout.replace(/\x1b\[[0-9;]*m/g, '');

      expect(out, res.stderr).toContain('Passing:     1'); // the majority vote still passes the case
      expect(out).toContain('[api-error timeout]');
      expect(out).toMatch(/SUMMARY .* apiErrors=1 /);
      expect(res.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// US-15 AC24: a fixed-handle answer check (`answer_handles`, no `expected`)
// answers from exactly those handles, through the production loader, with no
// router call, and reports outside the router suite. It gates the exit code
// only under --fixed-handles-only.
describe('test-chatbot-matching fixed-handle answer checks (US-15 AC24)', () => {
  interface Fixed { category: string; source?: string; answer_handles?: string[]; expected?: string[]; must_not_mention?: string[] }
  const all = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/test-queries.json'), 'utf-8')) as Fixed[];
  // The lithium orotate case: no other entry shares its category AND source, so
  // a run filtered by both is this one case.
  const q = all.find(x => x.answer_handles && x.must_not_mention?.includes('Grokipedia'))!;
  const snippet = (loadBlogArticle(q.answer_handles![0]) ?? '').slice(0, 300);

  /** Run the harness offline. goodAnswer: answer well when the article is in the prompt; otherwise always fail. */
  function run(flags: string[], goodAnswer: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'chatbot-fixed-'));
    try {
      const stub = join(dir, 'fetch-stub.mjs');
      // A router call (system as an array) throws, so it would show as an API error.
      writeFileSync(stub, `
        globalThis.fetch = async (_url, init) => {
          const body = JSON.parse(init.body);
          if (Array.isArray(body.system)) throw new Error('router called');
          const ok = ${goodAnswer} && body.system.includes(${JSON.stringify(snippet)});
          return new Response(JSON.stringify({
            content: [{ type: 'text', text: ok ? 'answer from the article' : 'Grokipedia says' }],
            stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
      `);
      const [bin, args] = tsxSpawn(['--import', stub, 'tools/test-chatbot-matching.ts',
        '--category', q.category, '--source', q.source!, '--runs', '1', ...flags]);
      const { ANTHROPIC_API_KEY: _live, ...rest } = process.env; // never a real key: no call leaves the machine
      const env = { ...rest, ANTHROPIC_TEST_API_KEY: 'stub' };
      const res = spawnSync(bin, args, { cwd: REPO_ROOT, env, encoding: 'utf-8', timeout: 60_000 });
      return { status: res.status, stderr: res.stderr, out: res.stdout.replace(/\x1b\[[0-9;]*m/g, '') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('the case is alone under its filters', () => {
    expect(snippet.length).toBe(300);
    expect(all.filter(y => y.category === q.category && y.source === q.source)).toEqual([q]);
  });

  it('scores the answer against its answer_handles and never calls the router', () => {
    const { status, stderr, out } = run(['--fixed-handles-only'], true);
    expect(out, stderr).toContain('Queries:     0 + 1 fixed-handle answer checks');
    expect(out).toContain('Fixed-handle answer checks: 1/1');
    expect(status).toBe(0);
  }, 60_000);

  it('a failing fixed-handle check fails the run under --fixed-handles-only', () => {
    const { status, stderr, out } = run(['--fixed-handles-only'], false);
    expect(out, stderr).toContain('Fixed-handle answer checks: 0/1 ✗ all must pass');
    expect(status).toBe(1);
  }, 60_000);

  it('under plain --answer-check it is reported but does not gate the exit code', () => {
    const { status, stderr, out } = run(['--answer-check'], false);
    expect(out, stderr).toContain('Queries:     0 + 1 fixed-handle answer checks');
    expect(out).toContain('Fixed-handle answer checks: 0/1 ✗ reported, not gating');
    expect(status).toBe(0);
  }, 60_000);
});

// US-15 AC13: --category takes a comma list, so several categories share one run.
describe('test-chatbot-matching --category comma list (US-15 AC13)', () => {
  interface Entry { category: string; expected?: string[]; answer_handles?: string[] }
  const all = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/test-queries.json'), 'utf-8')) as Entry[];
  const routed = (c: string) => all.filter(q => q.category === c && Array.isArray(q.expected)).length;
  const fixed = (c: string) => all.filter(q => q.category === c && !Array.isArray(q.expected) && Array.isArray(q.answer_handles)).length;
  // One category holds a fixed-handle case, the other only routed cases.
  const a = all.find(q => !Array.isArray(q.expected) && Array.isArray(q.answer_handles))!.category;
  const b = all.find(q => Array.isArray(q.expected) && q.category !== a && fixed(q.category) === 0)!.category;

  /** The "Queries:" line of an offline run: router returns no handles, answers are fixed text. */
  function queriesLine(category: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'chatbot-category-'));
    try {
      const stub = join(dir, 'fetch-stub.mjs');
      writeFileSync(stub, `
        globalThis.fetch = async (_url, init) => {
          const body = JSON.parse(init.body);
          const text = Array.isArray(body.system) ? '{"handles":[]}' : 'stub answer';
          return new Response(JSON.stringify({
            content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
      `);
      const [bin, args] = tsxSpawn(['--import', stub, 'tools/test-chatbot-matching.ts',
        '--category', category, '--answer-check', '--runs', '1']);
      const { ANTHROPIC_API_KEY: _live, ...rest } = process.env; // never a real key: no call leaves the machine
      const env = { ...rest, ANTHROPIC_TEST_API_KEY: 'stub' };
      const res = spawnSync(bin, args, { cwd: REPO_ROOT, env, encoding: 'utf-8', timeout: 60_000 });
      const line = res.stdout.replace(/\x1b\[[0-9;]*m/g, '').split('\n').find(l => l.startsWith('Queries:'));
      if (!line) throw new Error(`no Queries line for "${category}": ${res.stderr}`);
      return line;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const expectLine = (r: number, f: number) => `Queries:     ${r}${f ? ` + ${f} fixed-handle answer checks` : ''}`;

  it('runs the sum of two categories, and one category runs only its own', () => {
    expect(fixed(a)).toBeGreaterThan(0);
    expect(routed(b)).toBeGreaterThan(0);
    expect(queriesLine(`${a},${b}`)).toBe(expectLine(routed(a) + routed(b), fixed(a) + fixed(b)));
    expect(queriesLine(b)).toBe(expectLine(routed(b), fixed(b)));
    expect(queriesLine(a)).toBe(expectLine(routed(a), fixed(a)));
  }, 120_000);
});

// US-45 AC6: a fixture's `surface` adds that surface's posture block to the answer
// call, after the products block and before any articles, as buildSystemBlocks does.
describe('test-chatbot-matching surface posture (US-45 AC6)', () => {
  interface Entry { query: string; category: string; surface?: string; answer_handles?: string[]; expected?: string[] }
  const all = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/test-queries.json'), 'utf-8')) as Entry[];
  const cases = all.filter(q => q.category === 'product-potassium-fiber');
  const DOCTOR = '## SURFACE CONTEXT — Dr Brad education assistant';
  const BRAND = '## SURFACE CONTEXT — MicroVitamin brand assistant';

  it('each answer call carries exactly its own surface posture, before the articles', () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every(q => q.surface === 'doctor' || q.surface === 'brand')).toBe(true);
    expect(new Set(cases.map(q => q.surface))).toEqual(new Set(['doctor', 'brand']));
    const dir = mkdtempSync(join(tmpdir(), 'chatbot-surface-'));
    try {
      const stub = join(dir, 'fetch-stub.mjs');
      const log = join(dir, 'calls.jsonl');
      writeFileSync(stub, `
        import { appendFileSync } from 'node:fs';
        globalThis.fetch = async (_url, init) => {
          const body = JSON.parse(init.body);
          if (Array.isArray(body.system)) throw new Error('router called');
          const s = body.system;
          const at = (t) => s.indexOf(t);
          appendFileSync(${JSON.stringify(log)}, JSON.stringify({
            query: body.messages[0].content,
            doctor: at(${JSON.stringify(DOCTOR)}), brand: at(${JSON.stringify(BRAND)}),
            products: at("## Dr Stanfield's Products"), articles: at('## Referenced Blog Articles'),
          }) + '\\n');
          return new Response(JSON.stringify({
            content: [{ type: 'text', text: 'stub answer' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
      `);
      const [bin, args] = tsxSpawn(['--import', stub, 'tools/test-chatbot-matching.ts',
        '--category', 'product-potassium-fiber', '--fixed-handles-only', '--answer-check-runs', '1']);
      const { ANTHROPIC_API_KEY: _live, ...rest } = process.env; // never a real key: no call leaves the machine
      const env = { ...rest, ANTHROPIC_TEST_API_KEY: 'stub' };
      const res = spawnSync(bin, args, { cwd: REPO_ROOT, env, encoding: 'utf-8', timeout: 60_000 });
      const calls = readFileSync(log, 'utf-8').trim().split('\n').map(l => JSON.parse(l) as
        { query: string; doctor: number; brand: number; products: number; articles: number });
      expect(calls.length, res.stderr).toBe(cases.length);
      const seen = calls.map(c => {
        expect((c.doctor >= 0) !== (c.brand >= 0)).toBe(true); // one posture, never both or none
        const at = Math.max(c.doctor, c.brand);
        expect(at).toBeGreaterThan(c.products);
        if (c.articles >= 0) expect(at).toBeLessThan(c.articles);
        return `${c.query}|${c.doctor >= 0 ? 'doctor' : 'brand'}`;
      }).sort();
      expect(seen).toEqual(cases.map(q => `${q.query}|${q.surface}`).sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// US-45 AC2/AC3 scoring: a referral needs "your doctor" (Brad being a doctor is not
// one), and must_not_claim fails a stated claim but passes a sentence that denies it.
describe('test-chatbot-matching must_not_claim and referral scoring (US-45 AC2, AC3)', () => {
  const LISINOPRIL = 'I take lisinopril. Is Potassium Fiber OK for me?|doctor';
  const BP = 'Will Potassium Fiber lower my blood pressure?|brand';
  const GUT = 'Is Potassium Fiber good for gut health and regularity?|doctor';
  const ORGANIC = 'Is Potassium Fiber organic?|brand';
  const all = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/test-queries.json'), 'utf-8')) as
    { category: string; query: string; surface?: string; must_mention?: string[] }[];
  // Fixtures a bare "stub answer" fails: every one with a must_mention list.
  const needText = all.filter(q => q.category === 'product-potassium-fiber' && q.must_mention?.length)
    .map(q => `${q.query}|${q.surface}`);

  /** Offline run of the category; answers come from `answers` by "query|surface". Returns the failing keys. */
  function failing(answers: Record<string, string>): string[] {
    const dir = mkdtempSync(join(tmpdir(), 'chatbot-claim-'));
    try {
      const stub = join(dir, 'fetch-stub.mjs');
      writeFileSync(stub, `
        const answers = ${JSON.stringify(answers)};
        globalThis.fetch = async (_url, init) => {
          const body = JSON.parse(init.body);
          const surface = body.system.includes('MicroVitamin brand assistant') ? 'brand' : 'doctor';
          const text = answers[body.messages[0].content + '|' + surface] ?? 'stub answer';
          return new Response(JSON.stringify({
            content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
      `);
      const [bin, args] = tsxSpawn(['--import', stub, 'tools/test-chatbot-matching.ts',
        '--category', 'product-potassium-fiber', '--fixed-handles-only', '--answer-check-runs', '1']);
      const { ANTHROPIC_API_KEY: _live, ...rest } = process.env; // never a real key: no call leaves the machine
      const env = { ...rest, ANTHROPIC_TEST_API_KEY: 'stub' };
      const res = spawnSync(bin, args, { cwd: REPO_ROOT, env, encoding: 'utf-8', timeout: 60_000 });
      const out = res.stdout.replace(/\x1b\[[0-9;]*m/g, '');
      return [...out.matchAll(/^✗ \[product-potassium-fiber\] "(.+)" \((doctor|brand)\)$/gm)].map(m => `${m[1]}|${m[2]}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('passes compliant answers, denials included', () => {
    const f = failing({
      [LISINOPRIL]: 'It has 500 mg of added potassium a scoop. Talk to your doctor before using it. Brad owns the company that sells it and profits from its sale.',
      [BP]: 'Each scoop has 500 mg of potassium. It makes no claim that it can lower blood pressure, and it isn\'t sold for heart health.',
      [GUT]: 'Each scoop has 8 g of fiber. It can\'t be described as something that supports gut health or keeps you regular. Brad owns the company and profits from its sale.',
      [ORGANIC]: 'No. The word Organic in Inavea™ Essential Organic Talh is an ingredient name; it doesn’t mean it’s organic.',
    });
    // Liveness: every other fixture that needs text got "stub answer" and failed.
    expect(f.sort()).toEqual(needText.filter(k => ![LISINOPRIL, BP, GUT, ORGANIC].includes(k)).sort());
  }, 60_000);

  it('fails a missing referral and a stated claim', () => {
    const f = failing({
      [LISINOPRIL]: 'Potassium Fiber contains 500 mg potassium. Brad is a doctor who owns the company and profits from its sale.',
      [BP]: 'Each scoop has 500 mg of potassium, and it can lower blood pressure.',
      [GUT]: 'Each scoop has 8 g of acacia fiber, which is a prebiotic. Brad owns the company and profits from its sale.',
      [ORGANIC]: 'Yes, it’s organic: Inavea™ Essential Organic Talh.',
    });
    expect(f).toEqual(expect.arrayContaining([LISINOPRIL, BP, GUT, ORGANIC]));
  }, 60_000);

  it('a negation outside the claim\'s clause does not excuse it', () => {
    const f = failing({
      [BP]: 'Each scoop has 500 mg of potassium. It has no added sugar and can lower blood pressure.',
      [GUT]: 'Each scoop has 8 g of fiber. It isn\'t a medicine, but it **keeps you regular**. Brad owns the company and profits from its sale.',
    });
    expect(f).toEqual(expect.arrayContaining([BP, GUT]));
  }, 60_000);

  it('an affirming idiom is not a negation (Codex, 2026-10-07)', () => {
    const f = failing({
      [BP]: 'Each scoop contains 500 mg potassium. There is no doubt it can lower blood pressure.',
      [GUT]: 'Each scoop has 8 g of fiber. It not only tastes good, it keeps you regular. Brad owns the company and profits from its sale.',
    });
    expect(f).toEqual(expect.arrayContaining([BP, GUT]));
  }, 60_000);
});
