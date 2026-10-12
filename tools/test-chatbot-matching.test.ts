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
import { resolveChatContext } from '../app/lib/chat.server';

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
      [BP]: 'It makes no health claims and is sold for its nutrient content: each scoop has 8 g of fiber and 500 mg of potassium. It makes no claim that it can lower blood pressure, and it isn\'t sold for heart health.',
      [GUT]: 'It makes no health claims and is sold for its nutrient content: 8 g of fiber and 500 mg of potassium a scoop. It can\'t be described as something that supports gut health or keeps you regular. Brad owns the company and profits from its sale.',
      [ORGANIC]: 'No. The word Organic in Inavea™ Essential Organic Talh is an ingredient name; it doesn’t mean it’s organic.',
    });
    // Liveness: every other fixture that needs text got "stub answer" and failed.
    expect(f.sort()).toEqual(needText.filter(k => ![LISINOPRIL, BP, GUT, ORGANIC].includes(k)).sort());
  }, 60_000);

  // Every failing stub below carries the AC3 positioning, so only the claim under test can fail it.
  it('fails a missing referral and a stated claim', () => {
    const f = failing({
      [LISINOPRIL]: 'Potassium Fiber contains 500 mg potassium. Brad is a doctor who owns the company and profits from its sale.',
      [BP]: 'It makes no health claims and is sold for its nutrient content: 8 g of fiber and 500 mg of potassium a scoop. Each scoop has 500 mg of potassium, and it can lower blood pressure.',
      [GUT]: 'It makes no health claims and is sold for its nutrient content: 8 g of fiber and 500 mg of potassium a scoop. Each scoop has 8 g of acacia fiber, which is a prebiotic. Brad owns the company and profits from its sale.',
      [ORGANIC]: 'Yes, it’s organic: Inavea™ Essential Organic Talh.',
    });
    expect(f).toEqual(expect.arrayContaining([LISINOPRIL, BP, GUT, ORGANIC]));
  }, 60_000);

  it('a negation outside the claim\'s clause does not excuse it', () => {
    const f = failing({
      [BP]: 'It makes no health claims and is sold for its nutrient content: 8 g of fiber and 500 mg of potassium a scoop. Each scoop has 500 mg of potassium. It has no added sugar and can lower blood pressure.',
      [GUT]: 'It makes no health claims and is sold for its nutrient content: 8 g of fiber and 500 mg of potassium a scoop. Each scoop has 8 g of fiber. It isn\'t a medicine, but it **keeps you regular**. Brad owns the company and profits from its sale.',
    });
    expect(f).toEqual(expect.arrayContaining([BP, GUT]));
  }, 60_000);

  it('an affirming idiom is not a negation (Codex, 2026-10-07)', () => {
    const f = failing({
      [BP]: 'It makes no health claims and is sold for its nutrient content: 8 g of fiber and 500 mg of potassium a scoop. Each scoop contains 500 mg potassium. There is no doubt it can lower blood pressure.',
      [GUT]: 'It makes no health claims and is sold for its nutrient content: 8 g of fiber and 500 mg of potassium a scoop. Each scoop has 8 g of fiber. It not only tastes good, it keeps you regular. Brad owns the company and profits from its sale.',
    });
    expect(f).toEqual(expect.arrayContaining([BP, GUT]));
    // Omitting the no-health-claims positioning fails, and so does the MicroVitamin disclaimer line (US-45 AC3, AC4).
    expect(failing({ [BP]: 'Each scoop has 8 g of fiber and 500 mg of potassium.' })).toContain(BP);
    expect(failing({
      [BP]: 'It makes no health claims and is sold for its nutrient content: 8 g of fiber and 500 mg of potassium a scoop. This isn\'t a disease claim; MicroVitamin is a daily multivitamin, not a treatment for any condition.',
    })).toContain(BP);
    // Medicine spacing needs the two-hour, before-or-after direction (US-45 AC7).
    const MEDS = 'Can I take Potassium Fiber with my other medicines?|brand';
    expect(failing({ [MEDS]: 'Yes, you can take it with your medicines.' })).toContain(MEDS);
    expect(failing({ [MEDS]: 'Take other medicines at least two hours before or after a scoop.' })).not.toContain(MEDS);
    expect(failing({ [MEDS]: 'Take other medicines no more than two hours before or after a scoop.' })).toContain(MEDS);
    // A reversed positioning fails (Codex, 2026-10-07).
    expect(failing({
      [BP]: 'It makes health claims and is sold for its nutrient content: each scoop has 8 g of fiber and 500 mg of potassium.',
    })).toContain(BP);
    // An outcome-research summary fails even with no claim phrase (orchestrator ruling, 2026-10-07).
    expect(failing({
      [BP]: 'It makes no health claims and is sold for its nutrient content: 8 g of fiber and 500 mg of potassium a scoop. Each scoop has 500 mg of potassium. A meta-analysis of 25 randomized trials found potassium supplementation lowered systolic pressure by 4.48 mmHg.',
    })).toContain(BP);
    // Masking keeps the window's span: "cannot" sits 14 words back, outside it.
    expect(failing({
      [BP]: 'It makes no health claims and is sold for its nutrient content: 8 g of fiber and 500 mg of potassium a scoop. Each scoop contains 500 mg potassium. I cannot speak for other commercial products, though there is no doubt this particular drink can lower blood pressure.',
    })).toContain(BP);
  }, 60_000);
});

// US-15 AC28: the harness parses a router reply as production does. A corrected
// second object routes the case; a reply nothing parses is an error, never a
// silent ∅ (chat-health W41: the 10-07 shape scored as an empty route).
describe('test-chatbot-matching router reply parsing (US-15 AC28)', () => {
  const q = pickCase();

  /** Run the one-case category offline; the router answers `routerText` for the case's own query. */
  function run(routerText: string) {
    const dir = mkdtempSync(join(tmpdir(), 'chatbot-reply-'));
    try {
      const stub = join(dir, 'fetch-stub.mjs');
      // The cache warmup asks about "health": it gets a clean empty route.
      writeFileSync(stub, `
        globalThis.fetch = async (_url, init) => {
          const body = JSON.parse(init.body);
          const mine = body.messages[0].content.includes(${JSON.stringify(q.query)});
          return new Response(JSON.stringify({
            content: [{ type: 'text', text: mine ? ${JSON.stringify(routerText)} : '{"handles":[]}' }],
            stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
      `);
      const [bin, args] = tsxSpawn(['--import', stub, 'tools/test-chatbot-matching.ts', '--category', q.category, '--runs', '1']);
      const { ANTHROPIC_API_KEY: _live, ...rest } = process.env; // never a real key: no call leaves the machine
      const env = { ...rest, ANTHROPIC_TEST_API_KEY: 'stub' };
      const res = spawnSync(bin, args, { cwd: REPO_ROOT, env, encoding: 'utf-8', timeout: 60_000 });
      return { status: res.status, stderr: res.stderr, out: res.stdout.replace(/\x1b\[[0-9;]*m/g, '') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('routes on the corrected second object', () => {
    const text = `{"handles": ["guideline-${q.expected[0]}x"]}\n\nCorrection: copying handles exactly from the index (without the type label):\n\n{"handles": ["${q.expected[0]}"]}`;
    const { status, stderr, out } = run(text);
    expect(out, stderr).toContain('Passing:     1');
    expect(out).toMatch(/SUMMARY .* apiErrors=0 /);
    expect(status).toBe(0);
  }, 60_000);

  it('counts a reply nothing parses as an error and exits non-zero', () => {
    const { status, stderr, out } = run('Sorry, nothing in the index fits.');
    expect(out, stderr).toContain('[parse-error');
    expect(out).toMatch(/SUMMARY .* apiErrors=1 /);
    expect(status).toBe(1);
  }, 60_000);
});

// US-15 (issue #135, 2026-10-12): a fixture's `user_context` reaches the answer as
// production builds it: the widget payload through resolveChatContext, the system
// through buildSystemBlocks with the fixture's posture. A payload that would not
// make the intended plan, or a fixture with no posture, exits the harness before
// any API call; an explicit {} is production's empty context.
describe('test-chatbot-matching user_context (US-15, issue #135)', () => {
  interface Entry {
    query: string; category: string; surface?: string; answer_handles?: string[]; user_context?: unknown;
    must_mention?: string[]; must_match?: string[]; must_not_match?: string[];
  }
  const all = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/test-queries.json'), 'utf-8')) as Entry[];
  const CATEGORIES = 'own-data-analysis,algorithm-precedence';
  const cases = all.filter(q => CATEGORIES.split(',').includes(q.category));

  /** Run the harness offline; `fixtures` (if given) replaces tools/test-queries.json. Returns the answer calls' systems. */
  function run(fixtures?: Entry[], answer = 'stub answer') {
    const dir = mkdtempSync(join(tmpdir(), 'chatbot-user-context-'));
    try {
      const stub = join(dir, 'fetch-stub.mjs');
      const log = join(dir, 'calls.jsonl');
      writeFileSync(stub, `
        import fs from 'node:fs';
        const fixtures = ${JSON.stringify(fixtures ?? null)};
        const read = fs.readFileSync;
        if (fixtures) fs.readFileSync = (p, ...rest) => String(p).endsWith('tools/test-queries.json') ? JSON.stringify(fixtures) : read(p, ...rest);
        globalThis.fetch = async (_url, init) => {
          const body = JSON.parse(init.body);
          fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ query: body.messages[0].content, system: body.system, tools: !!body.tools }) + '\\n');
          return new Response(JSON.stringify({
            content: [{ type: 'text', text: ${JSON.stringify(answer)} }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
      `);
      const [bin, args] = tsxSpawn(['--import', stub, 'tools/test-chatbot-matching.ts',
        '--category', CATEGORIES, '--fixed-handles-only', '--answer-check-runs', '1']);
      const { ANTHROPIC_API_KEY: _live, ...rest } = process.env; // never a real key: no call leaves the machine
      const env = { ...rest, ANTHROPIC_TEST_API_KEY: 'stub' };
      const res = spawnSync(bin, args, { cwd: REPO_ROOT, env, encoding: 'utf-8', timeout: 60_000 });
      let calls: Array<{ query: string; system: Array<{ text: string }>; tools: boolean }> = [];
      try { calls = readFileSync(log, 'utf-8').trim().split('\n').map(l => JSON.parse(l)); } catch { /* no call made */ }
      return { status: res.status, stderr: res.stderr, out: res.stdout.replace(/\x1b\[[0-9;]*m/g, ''), calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('each answer call carries its own user data block, after the doctor posture and before the articles', () => {
    expect(cases.length).toBeGreaterThan(0);
    const { stderr, calls } = run();
    expect(calls.length, stderr).toBe(cases.length);
    for (const q of cases) {
      // Two fixtures may share a query; the user data block tells them apart.
      const block = `## Current User Health Data\n\n${resolveChatContext(q.user_context).userContextJson}`;
      const call = calls.find(c => c.query === q.query && c.system.some(b => b.text === block))!;
      expect(call, q.query).toBeDefined();
      expect(call.tools).toBe(true); // an answer call, never the router
      const texts = call.system.map(b => b.text);
      const user = texts.indexOf(block);
      const posture = texts.findIndex(t => t.startsWith('## SURFACE CONTEXT — Dr Brad education assistant'));
      const articles = texts.findIndex(t => t.startsWith('## Referenced Blog Articles'));
      expect(texts[0].startsWith(readFileSync(join(REPO_ROOT, 'app/lib/chat-system-prompt.md'), 'utf-8'))).toBe(true);
      expect(posture).toBeGreaterThan(0);
      expect(user).toBe(posture + 1);
      if (q.answer_handles!.length > 0) expect(articles).toBe(user + 1);
      else expect(articles).toBe(-1);
    }
  }, 60_000);

  it('a payload that makes no plan, carries an unknown key or loses a value exits before any API call', () => {
    const good = { sex: 'male', heightCm: 178, unitSystem: 'si', medications: [], screenings: [] };
    const fixture = (user_context: unknown): Entry => ({ query: 'how am I doing?', category: 'own-data-analysis', surface: 'doctor', answer_handles: [], user_context, must_mention: ['x'] });
    expect(run([fixture(good)]).calls.length).toBe(1); // liveness: the good payload is answered
    for (const bad of [{ ...good, sex: undefined }, { ...good, ldl: 3.6 }, { ...good, hba1c: 400 }, 'male, 178 cm']) {
      const { status, stderr, calls } = run([fixture(bad)]);
      expect(stderr).toMatch(/user_context does not parse.* on: how am I doing\?/);
      expect(calls).toEqual([]);
      expect(status).toBe(1);
    }
  }, 120_000);

  it('an explicit {} sends production\'s empty context; a fixture with no surface exits before any API call', () => {
    const fixture = (extra: Partial<Entry>): Entry => ({ query: 'can you analyze my data', category: 'own-data-analysis', surface: 'doctor', answer_handles: [], user_context: {}, must_mention: ['x'], ...extra });
    const empty = run([fixture({})]);
    expect(empty.calls.length, empty.stderr).toBe(1);
    expect(empty.calls[0].system.map(b => b.text)).toContain('## Current User Health Data\n\n{}');
    const noSurface = run([fixture({ surface: undefined })]);
    expect(noSurface.stderr).toMatch(/user_context needs a surface on: can you analyze my data/);
    expect(noSurface.calls).toEqual([]);
    expect(noSurface.status).toBe(1);
  }, 60_000);

  // Adversary 2026-10-12: the BMI 32 case passed its must_mention on the baseline, and failed an
  // answer that gave metformin first-line as the NZ pathway's. Its regexes score whose order it is.
  it('must_match and must_not_match score whose first step it is (the BMI 32 diabetes case)', () => {
    const p3 = cases.find(q => q.query === 'Which diabetes medicine would come first for me?' && q.must_match)!;
    const verdict = (answer: string) => run([p3], answer).status;
    // Baseline shape: the pathway's order only, GLP-1 only as the separate weight card.
    expect(verdict('Metformin is the usual first-line medicine in the loaded pathway. Your roadmap separately suggests discussing a GLP-1 medication for weight.')).toBe(1);
    // The roadmap's order first, the pathway's attributed: passes.
    expect(verdict('The **Health Roadmap’s** first medication step for you is a GLP-1 medication. In the NZ pathway, metformin is first-line, while the roadmap starts with GLP-1.')).toBe(0);
    // The roadmap's order as a numbered list, or "lists GLP-1 first", passes too.
    expect(verdict('The roadmap’s weight and diabetes medication cascade runs in this order:\n1. GLP-1 (tirzepatide preferred)\n2. SGLT2 inhibitor\n3. Metformin')).toBe(0);
    expect(verdict('Your roadmap’s own cascade lists GLP-1 first, then an SGLT2 inhibitor, then metformin.')).toBe(0);
    // Metformin as the roadmap's first step fails, even beside a GLP-1 first step.
    expect(verdict('Your roadmap starts with a GLP-1. Metformin is first in your roadmap for diabetes.')).toBe(1);
    expect(verdict('The roadmap’s first step is a GLP-1 medication, and your plan’s first step would be metformin.')).toBe(1);
  }, 120_000);

  it('a must_match or must_not_match regex that does not compile exits before any API call', () => {
    for (const extra of [{ must_match: ['(unclosed'] }, { must_not_match: ['[a-'] }]) {
      const { status, stderr, calls } = run([{ query: 'how am I doing?', category: 'own-data-analysis', surface: 'doctor', answer_handles: [], user_context: {}, ...extra }]);
      expect(stderr).toMatch(/regexes that do not compile/);
      expect(calls).toEqual([]);
      expect(status).toBe(1);
    }
  }, 60_000);
});
