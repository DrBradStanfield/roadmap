/**
 * The router and answer harness (tools/test-chatbot-matching.ts), offline: `fetch` is stubbed, so no
 * call leaves the machine and no real key is passed.
 *
 * Most cases run the harness in this process (runHarness, test audit TA-T01) or score an answer
 * directly (scoreAnswer). Five still spawn the real CLI through tsx, to prove the boundary: argv,
 * stdout and the exit code (US-15 AC13 timeout, AC28 parse error, --estimate with no key, the
 * pending listing, and one user_context request shape).
 *
 * US-15 AC13: an answer-check timeout counts as an API error. With three answer runs and a
 * majority vote, one timeout and two passes still pass the case, so only the error count keeps
 * the run from exiting green.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, tsxSpawn } from './test-helpers';
import { noColour, reply, runHarness, textReply } from './test-chatbot-matching-inprocess';
import { scoreAnswer, type AnswerChecks } from './harness-answers';
import { loadBlogArticle } from '../app/lib/matched-content';
import { stripFrontmatter } from '../app/lib/frontmatter';
import { resolveChatContext } from '../app/lib/chat.server';
import { runRoadmap } from '../packages/health-core/src/run-roadmap';
import { DISCORD_SAVED_CHAT, SAVED_CHAT_BY_RETENTION, YOUTUBE_SAVED_CHAT, savedChatBlock } from '../app/lib/chat-save-answers';

/** Run the real CLI under tsx, preloading the ES module `stub(log)` builds; calls it appends to `log` (JSON lines) come back. */
function spawnCli(stub: (log: string) => string, argv: string[], key = true) {
  const dir = mkdtempSync(join(tmpdir(), 'chatbot-cli-'));
  try {
    const file = join(dir, 'fetch-stub.mjs');
    const log = join(dir, 'calls.jsonl');
    writeFileSync(file, stub(log));
    const [bin, args] = tsxSpawn(['--import', file, 'tools/test-chatbot-matching.ts', ...argv]);
    const { ANTHROPIC_API_KEY: _live, ANTHROPIC_TEST_API_KEY: _test, ...rest } = process.env; // never a real key: no call leaves the machine
    const env = key ? { ...rest, ANTHROPIC_TEST_API_KEY: 'stub' } : rest;
    // A killed harness must throw: its missing lines would read as passes (deploy run 39484726768).
    const res = spawnSync(bin, args, { cwd: REPO_ROOT, env, encoding: 'utf-8', timeout: 110_000 });
    if (res.error) throw res.error;
    let calls: any[] = [];
    try { calls = readFileSync(log, 'utf-8').trim().split('\n').map(l => JSON.parse(l)); } catch { /* no call made */ }
    return { status: res.status, stderr: res.stderr, out: noColour(res.stdout), calls };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The answer text the harness scores: a text-only turn, no tool call. */
const textTurn = (text: string) => ({ final: { contentBlocks: [{ type: 'text' as const, text }] }, counts: null, proposedEdits: [] });

interface Case { query: string; category: string; expected: string[]; must_mention?: string[] }

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
  // CLI spawn 1 of 5: the apiErrors count reaches the real exit code.
  it('counts an answer-check timeout in apiErrors and exits non-zero', () => {
    const q = pickCase();
    // Router calls send `system` as an array; answer calls send a string.
    const { status, stderr, out } = spawnCli(() => `
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
    `, ['--category', q.category, '--answer-check', '--runs', '3']);

    expect(out, stderr).toContain('Passing:     1'); // the majority vote still passes the case
    expect(out).toContain('[api-error timeout]');
    expect(out).toMatch(/SUMMARY .* apiErrors=1 /);
    expect(status).toBe(1);
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
  // The body, not the frontmatter: the model never sees that (US-50 AC4).
  const snippet = stripFrontmatter(loadBlogArticle(q.answer_handles![0]) ?? '').slice(0, 300);

  /** Run the harness offline. goodAnswer: answer well when the article is in the prompt; otherwise always fail. */
  async function run(flags: string[], goodAnswer: boolean) {
    // A router call (system as an array) throws, so it would show as an API error.
    const { status, err, out } = await runHarness(['--category', q.category, '--source', q.source!, '--runs', '1', ...flags], {
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        if (Array.isArray(body.system)) throw new Error('router called');
        const ok = goodAnswer && body.system.includes(snippet);
        return textReply(ok ? 'answer from the article' : 'Grokipedia says');
      },
    });
    return { status, stderr: err, out: noColour(out) };
  }

  it('the case is alone under its filters', () => {
    expect(snippet.length).toBe(300);
    expect(all.filter(y => y.category === q.category && y.source === q.source)).toEqual([q]);
  });

  it('scores the answer against its answer_handles and never calls the router', async () => {
    const { status, stderr, out } = await run(['--fixed-handles-only'], true);
    expect(out, stderr).toContain('Queries:     0 + 1 fixed-handle answer checks');
    expect(out).toContain('Fixed-handle answer checks: 1/1');
    expect(status).toBe(0);
  }, 60_000);

  it('a failing fixed-handle check fails the run under --fixed-handles-only', async () => {
    const { status, stderr, out } = await run(['--fixed-handles-only'], false);
    expect(out, stderr).toContain('Fixed-handle answer checks: 0/1 ✗ all must pass');
    expect(status).toBe(1);
  }, 60_000);

  it('under plain --answer-check it is reported but does not gate the exit code', async () => {
    const { status, stderr, out } = await run(['--answer-check'], false);
    expect(out, stderr).toContain('Queries:     0 + 1 fixed-handle answer checks');
    expect(out).toContain('Fixed-handle answer checks: 0/1 ✗ reported, not gating');
    expect(status).toBe(0);
  }, 60_000);

  // Brad 2026-11-10: a failing answer prints in full and the answer calls show their cost, so no
  // run is repeated just to read what the bot said or what it cost.
  it('a failing answer prints the whole reply and an answer cost line', async () => {
    const { stderr, out } = await run(['--fixed-handles-only'], false);
    expect(out, stderr).toContain('Response (last run):');
    expect(out).toContain('      Grokipedia says');
    expect(out).toMatch(/SUMMARY answer .* pass=0\/1 .* calls=1 .*cost=\$/);
  }, 60_000);

  // CLI spawn 2 of 5: --estimate needs no key and exits 0 before any call (with the pin file's keyless case, TA-T03).
  it('--estimate prices the run, needs no key and makes no API call', () => {
    const { status, stderr, out, calls } = spawnCli(log => `
      import fs from 'node:fs';
      globalThis.fetch = async () => { fs.appendFileSync(${JSON.stringify(log)}, '{}\\n'); throw new Error('fetch called'); };
    `, ['--category', q.category, '--source', q.source!, '--runs', '1', '--fixed-handles-only', '--estimate'], false);
    expect(out, stderr).toMatch(/ESTIMATE router calls=0 \$0\.00; answer calls=1 up to \$0\.\d\d; .*No API call made\./);
    expect(out).not.toContain('=== Results');
    expect(calls).toEqual([]);
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
  async function queriesLine(category: string): Promise<string> {
    const res = await runHarness(['--category', category, '--answer-check', '--runs', '1'], {
      fetch: async (_url, init) => textReply(Array.isArray(JSON.parse(String(init.body)).system) ? '{"handles":[]}' : 'stub answer'),
    });
    const line = noColour(res.out).split('\n').find(l => l.startsWith('Queries:'));
    if (!line) throw new Error(`no Queries line for "${category}": ${res.err}`);
    return line;
  }
  const expectLine = (r: number, f: number) => `Queries:     ${r}${f ? ` + ${f} fixed-handle answer checks` : ''}`;

  it('runs the sum of two categories, and one category runs only its own', async () => {
    expect(fixed(a)).toBeGreaterThan(0);
    expect(routed(b)).toBeGreaterThan(0);
    expect(await queriesLine(`${a},${b}`)).toBe(expectLine(routed(a) + routed(b), fixed(a) + fixed(b)));
    expect(await queriesLine(b)).toBe(expectLine(routed(b), fixed(b)));
    expect(await queriesLine(a)).toBe(expectLine(routed(a), fixed(a)));
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

  it('each answer call carries exactly its own surface posture, before the articles', async () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every(q => q.surface === 'doctor' || q.surface === 'brand')).toBe(true);
    expect(new Set(cases.map(q => q.surface))).toEqual(new Set(['doctor', 'brand']));
    const calls: Array<{ query: string; doctor: number; brand: number; products: number; articles: number }> = [];
    const res = await runHarness(['--category', 'product-potassium-fiber', '--fixed-handles-only', '--answer-check-runs', '1'], {
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        if (Array.isArray(body.system)) throw new Error('router called');
        const at = (t: string) => (body.system as string).indexOf(t);
        calls.push({
          query: body.messages[0].content, doctor: at(DOCTOR), brand: at(BRAND),
          products: at("## Dr Stanfield's Products"), articles: at('## Referenced Blog Articles'),
        });
        return textReply('stub answer');
      },
    });
    expect(calls.length, res.err).toBe(cases.length);
    const seen = calls.map(c => {
      expect((c.doctor >= 0) !== (c.brand >= 0)).toBe(true); // one posture, never both or none
      const at = Math.max(c.doctor, c.brand);
      expect(at).toBeGreaterThan(c.products);
      if (c.articles >= 0) expect(at).toBeLessThan(c.articles);
      return `${c.query}|${c.doctor >= 0 ? 'doctor' : 'brand'}`;
    }).sort();
    expect(seen).toEqual(cases.map(q => `${q.query}|${q.surface}`).sort());
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
    (AnswerChecks & { category: string; query: string; surface?: string; expected?: string[]; answer_handles?: string[]; pending?: string })[];
  // The cases a --fixed-handles-only run of the category answers and scores.
  const fixedCases = all.filter(q => q.category === 'product-potassium-fiber' && !q.pending && !Array.isArray(q.expected) && Array.isArray(q.answer_handles));
  // Fixtures a bare "stub answer" fails: every one with a must_mention list.
  const needText = all.filter(q => q.category === 'product-potassium-fiber' && q.must_mention?.length)
    .map(q => `${q.query}|${q.surface}`);

  /** Each fixed-handle case of the category scored on `answers` by "query|surface" ("stub answer" otherwise). Returns the failing keys. */
  function failing(answers: Record<string, string>): string[] {
    return fixedCases.map(q => `${q.query}|${q.surface}`)
      .filter((key, i) => !scoreAnswer(fixedCases[i], textTurn(answers[key] ?? 'stub answer')).passed);
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

  it('routes on the corrected second object', async () => {
    const text = `{"handles": ["guideline-${q.expected[0]}x"]}\n\nCorrection: copying handles exactly from the index (without the type label):\n\n{"handles": ["${q.expected[0]}"]}`;
    // The cache warmup asks about "health": it gets a clean empty route.
    const res = await runHarness(['--category', q.category, '--runs', '1'], {
      fetch: async (_url, init) => textReply(JSON.parse(String(init.body)).messages[0].content.includes(q.query) ? text : '{"handles":[]}'),
    });
    const out = noColour(res.out);
    expect(out, res.err).toContain('Passing:     1');
    expect(out).toMatch(/SUMMARY .* apiErrors=0 /);
    expect(res.status).toBe(0);
  }, 60_000);

  // CLI spawn 3 of 5: a router parse error reaches the real exit code.
  it('counts a reply nothing parses as an error and exits non-zero', () => {
    const { status, stderr, out } = spawnCli(() => `
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        const mine = body.messages[0].content.includes(${JSON.stringify(q.query)});
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: mine ? 'Sorry, nothing in the index fits.' : '{"handles":[]}' }],
          stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
    `, ['--category', q.category, '--runs', '1']);
    expect(out, stderr).toContain('[parse-error');
    expect(out).toMatch(/SUMMARY .* apiErrors=1 /);
    expect(status).toBe(1);
  }, 60_000);
});

// TA-T01 follow-up (PR 1551 review): runHarness holds process-wide globals, so it must not overlap
// a run vitest abandoned on timeout, must not lean on vitest's cwd, and must not let a fetch with
// no stub pass as a counted API error.
describe('runHarness guards (test support, TA-T01)', () => {
  const q = pickCase();
  const route = (init: RequestInit) =>
    textReply(JSON.parse(String(init.body)).messages[0].content.includes(q.query) ? `{"handles":["${q.expected[0]}"]}` : '{"handles":[]}');

  it('refuses to start while an earlier run still holds the globals, and runs again once it restores', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let entered!: () => void;
    const inFetch = new Promise<void>(r => { entered = r; });
    const first = runHarness(['--category', q.category, '--runs', '1'], {
      fetch: async (_url, init) => { entered(); await gate; return route(init); },
    });
    await inFetch; // the first run is mid-fetch, as an abandoned case would be
    await expect(runHarness(['--category', q.category, '--runs', '1'], { fetch: async (_u, init) => route(init) }))
      .rejects.toThrow(/earlier run has not restored/);
    release();
    expect((await first).status).toBe(0);
    const third = await runHarness(['--category', q.category, '--runs', '1'], { fetch: async (_u, init) => route(init) });
    expect(noColour(third.out), third.err).toContain('Passing:     1');
    expect(third.status).toBe(0);
  }, 60_000);

  it('reports the repo root as cwd wherever vitest was launched', async () => {
    const real = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'chatbot-matching-cwd-'));
    process.chdir(dir);
    try {
      const res = await runHarness(['--category', q.category, '--runs', '1'], { fetch: async (_u, init) => route(init) });
      expect(noColour(res.out), res.err).toContain('Passing:     1');
      expect(res.status).toBe(0);
    } finally {
      process.chdir(real);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails the case when the harness calls fetch with no stub given', async () => {
    await expect(runHarness(['--category', q.category, '--runs', '1'])).rejects.toThrow(/unexpected fetch with no stub given: https:\/\/api\.anthropic\.com/);
    // The globals came back: a stubbed run works straight after.
    expect((await runHarness(['--category', q.category, '--runs', '1'], { fetch: async (_u, init) => route(init) })).status).toBe(0);
  }, 60_000);
});

// US-15 (issue #135, 2026-10-12): a fixture's `user_context` reaches the answer as
// production builds it: the widget payload through resolveChatContext, the system
// through buildSystemBlocks with the fixture's posture. A payload that would not
// make the intended plan, or a fixture with no posture, exits the harness before
// any API call; an explicit {} is production's empty context.
describe('test-chatbot-matching user_context (US-15, issue #135)', () => {
  interface Entry extends AnswerChecks {
    query: string; category: string; surface?: string; answer_handles?: string[]; expected?: string[]; user_context?: unknown;
    expect_no_plan?: true;
  }
  const all = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/test-queries.json'), 'utf-8')) as Entry[];
  const CATEGORIES = 'own-data-analysis,algorithm-precedence,algorithm-precedence-parked,minor-gate';
  // Only the fixed-handle answer checks the harness runs under --fixed-handles-only (no `expected`, an
  // `answer_handles` list): a router fixture in the same category makes no answer call (W45 renin, 2026-11-07).
  const cases = all.filter(q => CATEGORIES.split(',').includes(q.category)
    && !Array.isArray(q.expected) && Array.isArray(q.answer_handles));

  type Call = { query: string; system: Array<{ text: string }>; tools: boolean };
  const lastUserText = (body: { messages: Array<{ role: string; content: unknown }> }) =>
    body.messages.filter(m => m.role === 'user' && typeof m.content === 'string').at(-1)!.content as string;

  /** Run the harness offline; `fixtures` (if given) replaces tools/test-queries.json. Returns the answer calls' systems. */
  async function run(fixtures?: Entry[], answer: string | Record<string, string> = 'stub answer') {
    const calls: Call[] = [];
    const res = await runHarness(['--category', CATEGORIES, '--fixed-handles-only', '--answer-check-runs', '1'], {
      fixtures,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        const query = lastUserText(body);
        calls.push({ query, system: body.system, tools: !!body.tools });
        return textReply(typeof answer === 'string' ? answer : answer[query]);
      },
    });
    return { status: res.status, stderr: res.err, out: noColour(res.out), calls };
  }

  // C1 (US-45 AC8): a doctor user_context fixture defaults to the widget's SAVED-CHAT block, which
  // production places between the posture and the user data.
  // CLI spawn 4 of 5: the request the real CLI sends carries production's system blocks in order.
  it('each answer call carries its own user data block, after the doctor posture and its SAVED-CHAT block, and before the articles', () => {
    expect(cases.length).toBeGreaterThan(0);
    const { stderr, calls } = spawnCli(log => `
      import fs from 'node:fs';
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        const query = body.messages.filter(m => m.role === 'user' && typeof m.content === 'string').at(-1).content;
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ query, system: body.system, tools: !!body.tools }) + '\\n');
        return new Response(JSON.stringify({
          content: [{ type: 'text', text: 'stub answer' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
    `, ['--category', CATEGORIES, '--fixed-handles-only', '--answer-check-runs', '1']) as { stderr: string; calls: Call[] };
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
      expect(texts[posture + 1]).toBe(savedChatBlock(SAVED_CHAT_BY_RETENTION['question-rows']));
      expect(user).toBe(posture + 2);
      if (q.answer_handles!.length > 0) expect(articles).toBe(user + 1);
      else expect(articles).toBe(-1);
    }
  }, 60_000);

  it('a payload that makes no plan, carries an unknown key or loses a value exits before any API call', async () => {
    const good = { sex: 'male', heightCm: 178, unitSystem: 'si', medications: [], screenings: [] };
    const fixture = (user_context: unknown): Entry => ({ query: 'how am I doing?', category: 'own-data-analysis', surface: 'doctor', answer_handles: [], user_context, must_mention: ['x'] });
    expect((await run([fixture(good)])).calls.length).toBe(1); // liveness: the good payload is answered
    // US-07 AC8: no sex still makes a plan; no height does not.
    for (const bad of [{ ...good, heightCm: undefined }, { ...good, ldl: 3.6 }, { ...good, hba1c: 400 }, 'male, 178 cm']) {
      const { status, stderr, calls } = await run([fixture(bad)]);
      expect(stderr).toMatch(/user_context does not parse.* on: how am I doing\?/);
      expect(calls).toEqual([]);
      expect(status).toBe(1);
    }
  }, 120_000);

  it('an explicit {} sends production\'s empty context; a fixture with no surface exits before any API call', async () => {
    const fixture = (extra: Partial<Entry>): Entry => ({ query: 'can you analyze my data', category: 'own-data-analysis', surface: 'doctor', answer_handles: [], user_context: {}, must_mention: ['x'], ...extra });
    const empty = await run([fixture({})]);
    expect(empty.calls.length, empty.stderr).toBe(1);
    expect(empty.calls[0].system.map(b => b.text)).toContain('## Current User Health Data\n\n{}');
    const noSurface = await run([fixture({ surface: undefined })]);
    expect(noSurface.stderr).toMatch(/user_context needs a surface on: can you analyze my data/);
    expect(noSurface.calls).toEqual([]);
    expect(noSurface.status).toBe(1);
  }, 60_000);

  // US-15 AC36 (2026-10-18): production sends the saved values with no plan when the height is
  // missing (it used to send '{}'; since US-07 AC8 a missing sex still makes a plan). A fixture declares
  // a payload that makes no plan, so a payload that silently lost its height still exits; the harness
  // sends the context production sends.
  it('a payload declared expect_no_plan sends production\'s no-plan context; undeclared, or making a plan, it exits', async () => {
    const noHeight = { sex: 'female', systolicBp: 138, diastolicBp: 88, ldlC: 3.9, unitSystem: 'si', medications: [], screenings: [] };
    const fixture = (extra: Partial<Entry>): Entry => ({ query: 'can you analyze my data', category: 'own-data-analysis', surface: 'doctor', answer_handles: [], user_context: noHeight, must_mention: ['x'], ...extra });
    const declared = await run([fixture({ expect_no_plan: true })]);
    expect(declared.calls.length, declared.stderr).toBe(1);
    expect(declared.calls[0].system.map(b => b.text)).toContain(`## Current User Health Data\n\n${resolveChatContext(noHeight).userContextJson}`);
    expect(JSON.parse(resolveChatContext(noHeight).userContextJson).missingInputs).toContain('heightCm');
    for (const bad of [fixture({}), fixture({ expect_no_plan: true, user_context: { ...noHeight, heightCm: 168 } })]) {
      const { status, stderr, calls } = await run([bad]);
      expect(stderr).toMatch(/user_context does not parse.* on: can you analyze my data/);
      expect(calls).toEqual([]);
      expect(status).toBe(1);
    }
  }, 120_000);

  /** Each answer scored against the fixture's own checks, as a text-only reply.
   *  The stub answers in text only, so the tool-call check is left out (its own tests are in the run_roadmap block). */
  function verdicts(q: Entry, answers: string[]): Array<'pass' | 'fail'> {
    return answers.map(a => scoreAnswer({ ...q, expect_profile_edit: undefined }, textTurn(a)).passed ? 'pass' : 'fail');
  }
  const fixtureOf = (query: string, weightKg?: number) =>
    cases.find(q => q.query.startsWith(query) && (weightKg === undefined || (q.user_context as { weightKg?: number }).weightKg === weightKg))!;

  // Adversary round 2 (2026-10-12, R5): these synthetic bad answers passed the old regexes. Negation now
  // counts only before the claim in its sentence; the good answers include excerpts of logged real ones.
  it('the pregnancy case fails a GLP-1 given as her or the roadmap\'s first step (US-15 AC32)', () => {
    const bad = [
      "Your roadmap's cascade starts with a GLP-1 such as tirzepatide, not metformin. Insulin is another option.",
      "For you, the roadmap would start with a GLP-1, since you don't take one yet. Metformin and insulin are also options.",
      'Your roadmap starts with tirzepatide (a GLP-1). Metformin or insulin can follow. It is not a diagnosis.',
      "The roadmap's cascade puts a GLP-1 first for you. GLP-1s are not for everyone. Metformin and insulin are options.",
    ];
    const good = [
      "Pregnancy changes which medicines are used, so your roadmap's weight and diabetes medication cascade (GLP-1, then SGLT2 inhibitor, then metformin) doesn't apply to you. Metformin and insulin are the options. GLP-1 medicines, SGLT2 inhibitors and sulfonylureas should not be used in pregnancy.",
      'Metformin and insulin are the only medicines guidelines recommend in pregnancy. GLP-1 medicines should not be used. Your roadmap would normally start with a GLP-1, but that does not apply in pregnancy.',
      "Insulin or metformin. Your roadmap's cascade starts with a GLP-1, but GLP-1s are not used in pregnancy, so set that card aside.",
    ];
    expect(verdicts(fixtureOf("I'm 28 weeks pregnant"), [...bad, ...good])).toEqual([...bad.map(() => 'fail'), ...good.map(() => 'pass')]);
  }, 120_000);

  // US-15 AC36 (Codex and adversary on ed43aeb4/be12d288): the grade check works clause by clause, so a
  // negation or condition before the test name is a refusal, and a grade in another clause still fails.
  it('the AC36 fixture fails a grade of a saved value and passes a refusal to grade', () => {
    // Each answer carries the parts the fixture requires (a saved value, a height request and why), plus one test sentence.
    const ask = ' Your saved LDL is 3.9 mmol/L. Please tell me your height, because the roadmap needs it to work out your BMI and protein target. You can enter it in the roadmap tool.';
    const grades = [
      "Your LDL is high, but I can't run the plan without your height.",
      "I can't run your plan yet, but your LDL is high.",
      "I can't calculate your BMI without your height; your LDL is elevated.",
      'Not everything can be assessed yet, but your blood pressure is above target.',
      "Don't worry: your HbA1c is in range.",
      'I can’t give a full plan, though your cholesterol looks raised.',
      'Your LDL of 3.9 mmol/L is high, and if you share your height the roadmap can build your plan.',
      'Your LDL is above target, so ask your doctor whether a statin fits.',
      'Your LDL is classified as high.',
      'Your LDL, at 3.9 mmol/L, is high.',
      'LDL: 3.9 mmol/L is high.',
      'There is no doubt that your LDL is high.',
      'No need to panic — your LDL is only mildly elevated.',
      "I can't build your full plan yet — your LDL is high.",
      "I can't run your plan yet, and your LDL is high.",
      // Review R3 (2026-10-20): diagnosis words and other linking verbs.
      'Your blood pressure counts as stage 1 hypertension.',
      'Your HbA1c is in the prediabetes range.',
      'Your BP falls into the hypertension range.',
      'Your blood pressure qualifies as stage 2.',
    ];
    const refusals = [
      "I can't say your LDL is high without a roadmap plan.",
      'Your LDL is not graded as high or normal without a plan.',
      "I wouldn't say your LDL is high or normal until the roadmap runs.",
      "The roadmap doesn't yet say your blood pressure is high or normal.",
      "It isn't my place to say your LDL is high; the roadmap decides that.",
      "There's no way for me to say your LDL is high without the plan.",
      "Until you add your height, I'll hold off on saying your LDL is high or on target.",
      'Your LDL is not classified as high without a plan.',
      "I can't say whether your LDL and blood pressure are high without a plan.",
      "I can't say whether your LDL, blood pressure and HbA1c are high or normal until the roadmap has your height.",
      "I can't say whether your LDL (3.9), blood pressure (138/88) and HbA1c (40) are high or normal yet.",
      "I can't say whether your LDL of 3.9 and blood pressure of 138/88 are high or normal.",
      "I can't say whether your blood pressure counts as hypertension until the roadmap runs.",
    ];
    expect(verdicts(fixtureOf('what do my results show?'), [...grades, ...refusals].map(s => s + ask)))
      .toEqual([...grades.map(() => 'fail'), ...refusals.map(() => 'pass')]);
  }, 120_000);

  // US-15 AC36 (2026-10-20, Brad): with no plan, the bot asks for the missing value and says where to give
  // it. Since US-16 AC2 (same day) the chat proposes the save and the user confirms it, so the answer offers
  // the save and never says the chat cannot save, nor claims it already did.
  it('the AC36 fixtures fail an answer that skips the tool or claims to save the height', () => {
    const why = ' Your saved LDL is 3.9 mmol/L. Please tell me your height, because the roadmap needs it to work out your BMI and protein target.';
    // Review R1 (2026-10-20): a refusal that names the form without sending her there is not a pointer.
    expect(verdicts(fixtureOf('what do my results show?'), [why, why + " I can't add it to your profile.", why + ' Enter it in the roadmap tool and it can run your plan.']))
      .toEqual(['fail', 'fail', 'pass']);
    const bad = [
      "I've saved your height as 165 cm. Your roadmap can now run.",
      "Done! I've updated your height to 165 cm in the form.",
      'Your height is now saved. You can also enter it in the tool.',
      'Thanks! At 165 cm the roadmap can run your plan.',
      'Your height of 165 cm has been saved. You can also enter it in the tool.',
      "I've gone ahead and saved it. You can also enter it in the tool.",
      // US-16 AC2: the chat can save it now, with her confirmation.
      "I can't save your height from this chat. Please enter it in the roadmap tool.",
      "This chat can't store it, so add your height (165 cm) to your profile in the tool.",
      "I'm not able to save values here. Fill in your height in the form and press Save.",
      "I can't add it to your profile here.",
      // Review 2026-10-20 (adversary R3): a re-ask is not an offer to save.
      'Can you confirm your height? Then the roadmap can run.',
      'Could you confirm your height so I can save it?',
    ];
    const good = [
      "I've proposed saving your height of 165 cm. Please confirm it in the roadmap tool.",
      'Sure. Press **Save** on the banner to add 165 cm to your profile.',
      "I've added it to the banner for you to confirm. You can also enter it in the roadmap tool.",
      "I can't save it until you confirm. Tap Save when the banner appears.",
    ];
    expect(verdicts(fixtureOf('can you save my height'), [...bad, ...good])).toEqual([...bad.map(() => 'fail'), ...good.map(() => 'pass')]);
  }, 120_000);

  // US-15 AC36 review R2 (2026-10-20): the in-chat half. Sex and height stated this turn go through run_roadmap,
  // and the answer comes from its plan. The offline stub never calls the tool, so the regexes are scored directly,
  // on text lowercased with straight quotes as the harness scores it.
  it('the stated-sex-and-height fixture wants run_roadmap and fails an answer that asks again, refuses or claims a save', () => {
    const q = cases.find(c => c.query === "I'm 165 cm and male, analyse my data")!;
    expect(q.expect_no_plan).toBe(true);
    expect(q.expect_roadmap_run).toBe(true);
    const scores = (answer: string) => {
      const t = answer.toLowerCase().replace(/[’‘]/g, "'");
      return q.must_match!.every(r => new RegExp(r).test(t)) && !q.must_not_match!.some(r => new RegExp(r).test(t));
    };
    const tail = " I've proposed saving your sex and height; confirm them in the roadmap tool to keep them.";
    expect(scores('With your height and sex, the roadmap suggests talking to your doctor about your LDL.' + tail)).toBe(true);
    expect(scores('With your height and sex, the roadmap suggests talking to your doctor about your LDL. Enter them in the roadmap tool to keep them.')).toBe(true);
    for (const bad of [
      'What is your height? The roadmap needs it.' + tail,
      'The roadmap has no plan for you yet.' + tail,
      "I've saved your height and sex. Enter anything else in the form.",
      'From your roadmap, your LDL card says to talk to your doctor.', // no offer to save
      "These values aren't saved, and I can't add them to your profile.",
      "I can't save them from this chat, so enter your sex and height in the roadmap tool.", // US-16 AC2
      'With your height and sex, the roadmap suggests talking to your doctor. Can you confirm you are male?', // a re-ask
    ]) expect(scores(bad), bad).toBe(false);
    expect(q.expect_profile_edit).toEqual({ sex: 'male', heightCm: 165 });
  });

  it('the insulin case fails the roadmap\'s screening cut-offs given as her target (US-15 AC32)', () => {
    const bad = [
      'Your target, per the roadmap, is to get under 47.5 mmol/mol. Watch for hypoglycaemia.',
      'Your target is below 38.8 mmol/mol, not 53. Hypoglycaemia is a risk on insulin.',
      'Your roadmap target is below 5.7%. Hypoglycaemia risk matters.',
    ];
    const good = [
      "Your roadmap doesn't set a target for diagnosed diabetes. It only flags HbA1c at or above 47.5 mmol/mol as the diabetic range, and your latest value is 58 mmol/mol. - **Lower target (below 48 mmol/mol):** used when hypoglycaemia risk is low (not on insulin or sulfonylureas).",
      "HbA1c targets are individualised. The roadmap's 38.8 is a screening cut-off, not a target for you. On insulin guidelines list 53 to 70 to limit hypoglycaemia.",
    ];
    expect(verdicts(fixtureOf("I have type 2 diabetes and I'm on insulin"), [...bad, ...good])).toEqual([...bad.map(() => 'fail'), ...good.map(() => 'pass')]);
  }, 120_000);

  it('the BMI 23 case fails a GLP-1-first order the roadmap does not give her, in either word order or as a list (US-15 AC32)', () => {
    const bad = [
      "The roadmap's cascade puts a GLP-1 first for you, then an SGLT2 inhibitor, then metformin.",
      "The roadmap's medication cascade runs in this order:\n1. GLP-1\n2. SGLT2i\n3. Metformin",
      'Your roadmap starts with a GLP-1 for you.',
    ];
    const good = [
      "The roadmap's weight-and-diabetes medication cascade (GLP-1, then SGLT2 inhibitor, then metformin) is not triggered for you. The roadmap therefore does not name a first drug for you. A loaded guideline says healthy lifestyle measures plus metformin are first-line for type 2 diabetes.",
      "Your roadmap's cascade (GLP-1 first) is not triggered at a BMI of 23. The pathway starts with metformin.",
      "The roadmap's cascade starts with a GLP-1, but it only applies when the weight card shows, which it does not for you.",
    ];
    expect(verdicts(fixtureOf('Which diabetes medicine would come first', 73), [...bad, ...good])).toEqual([...bad.map(() => 'fail'), ...good.map(() => 'pass')]);
  }, 120_000);

  // Adversary 2026-10-12: the BMI 32 case passed its must_mention on the baseline, and failed an
  // answer that gave metformin first-line as the NZ pathway's. Its regexes score whose order it is.
  it('must_match and must_not_match score whose first step it is (the BMI 32 diabetes case)', () => {
    const p3 = cases.find(q => q.query === 'Which diabetes medicine would come first for me?' && q.must_match)!;
    const verdict = (answer: string) => scoreAnswer(p3, textTurn(answer)).passed ? 0 : 1; // the run's exit code
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
    // Round 2 (R5): the pathway's order with GLP-1 second, a GLP-1 'later', or metformin first for her, all fail.
    expect(verdicts(p3, [
      'Your roadmap shows a weight card, but the pathway puts metformin first, and GLP-1 second.',
      "The roadmap's GLP-1 card is separate. For diabetes, metformin comes first under the pathway, and your plan's first step is to see your doctor about a GLP-1 later.",
      'Your roadmap starts with a GLP-1. Metformin would come first for you.',
      "Your roadmap puts a GLP-1 first. The pathway's first-line medicine is metformin, so metformin would come first for you under the pathway.",
      // A logged answer on the round-2 prompt that the first regex missed ("a GLP-1 medication first").
      "The Health Roadmap's order for you is a GLP-1 medication first, then an SGLT2 inhibitor, then metformin. This is the roadmap's suggestion to discuss with your doctor, not a prescription.",
    ])).toEqual(['fail', 'fail', 'fail', 'pass', 'pass']);
  }, 120_000);

  // US-07 AC6 (2026-10-14): the minor-gate fixture's payload resolves to a knownMinor context, sent after the posture.
  it('the minor-gate fixture sends its knownMinor context after the posture (US-07 AC6)', async () => {
    const minor = all.find(q => q.category === 'minor-gate')!;
    expect(JSON.parse(resolveChatContext(minor.user_context).userContextJson).profile.knownMinor).toBe(true);
    const { status, stderr, out, calls } = await run([minor], 'The plan is built for adults. Please talk with your doctor.');
    expect(calls.length, stderr).toBe(1);
    const texts = calls[0].system.map(b => b.text);
    const data = texts.findIndex(t => t.startsWith('## Current User Health Data') && t.includes('"knownMinor": true'));
    // After the posture and the widget's SAVED-CHAT block, its C1 default (US-45 AC8).
    expect(data).toBe(texts.findIndex(t => t.startsWith('## SURFACE CONTEXT')) + 2);
    expect(out).toContain('Fixed-handle answer checks: 1/1');
    expect(status).toBe(0);
  }, 60_000);

  it('a must_match or must_not_match regex that does not compile exits before any API call', async () => {
    for (const extra of [{ must_match: ['(unclosed'] }, { must_not_match: ['[a-'] }]) {
      const { status, stderr, calls } = await run([{ query: 'how am I doing?', category: 'own-data-analysis', surface: 'doctor', answer_handles: [], user_context: {}, ...extra }]);
      expect(stderr).toMatch(/regexes that do not compile/);
      expect(calls).toEqual([]);
      expect(status).toBe(1);
    }
  }, 60_000);
});

// US-15 AC33: answer checks run production's one-round run_roadmap loop (the
// shared health-core withRoadmapRound) on the fixture's raw user_context, and
// are scored on the second call's text.
describe('test-chatbot-matching run_roadmap round (US-15 AC33)', () => {
  const PROFILE = { unitSystem: 'si', medications: [], screenings: [], sex: 'male', heightCm: 178, birthYear: 1975, birthMonth: 3, ldlC: 2.4 };
  const INPUT = { values: [{ field: 'ldlC', value: 4.1, unit: 'mmol/L' }] };
  const fixture = (extra: Record<string, unknown>) => ({
    query: 'analyse my data: LDL 4.1 mmol/L', category: 'own-data-analysis', surface: 'doctor', answer_handles: [],
    user_context: PROFILE, must_mention: ['from the roadmap'], ...extra,
  });

  /** Run one fixture offline: the first answer call asks for run_roadmap when `callTool`, the next answers. */
  async function run(fx: object, callTool: boolean) {
    const calls: Array<Record<string, any>> = [];
    const res = await runHarness(['--category', 'own-data-analysis', '--fixed-handles-only', '--answer-check-runs', '1'], {
      fixtures: [fx],
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        calls.push(body);
        const round = Array.isArray(body.messages.at(-1).content);
        const content = callTool && !round
          ? [{ type: 'thinking', thinking: 'run it', signature: 'sig' }, { type: 'tool_use', id: 'toolu_1', name: 'run_roadmap', input: INPUT }]
          : [{ type: 'text', text: round ? 'From the roadmap: LDL 4.1.' : 'A plain answer.' }];
        return reply(content, round || !callTool ? 'end_turn' : 'tool_use');
      },
    });
    return { status: res.status, stderr: res.err, out: noColour(res.out), calls };
  }

  it('the tool runs on the fixture\'s payload, the second call replays the first, and the answer is scored on it', async () => {
    const { status, stderr, out, calls } = await run(fixture({ expect_roadmap_run: true }), true);
    expect(calls.length, stderr).toBe(2);
    expect(calls[0].tools.map((t: { name: string }) => t.name)).toContain('run_roadmap');
    expect(calls[1].tool_choice).toEqual({ type: 'none' });
    expect(calls[1].messages[1].content[0]).toEqual({ type: 'thinking', thinking: 'run it', signature: 'sig' });
    const result = JSON.parse(calls[1].messages[2].content[0].content);
    expect(result.roadmap).toEqual(JSON.parse(runRoadmap(PROFILE, INPUT).contextJson!));
    expect(out).toContain('Fixed-handle answer checks: 1/1 ✓');
    expect(status).toBe(0);
  }, 60_000);

  it('as production, a query with no digit is not offered run_roadmap', async () => {
    const { calls, stderr } = await run(fixture({ query: 'can you analyse my data', must_mention: ['plain'] }), false);
    expect(calls.length, stderr).toBe(1);
    expect(calls[0].tools.map((t: { name: string }) => t.name)).toEqual(['propose_field_edit', 'propose_medication_edit', 'propose_profile_edit']);
  }, 60_000);

  it('a two-turn fixture sends its history before the query, and a digit in the previous user message offers run_roadmap (C2)', async () => {
    const history = [{ role: 'user', content: 'My Lp(a) came back at 75' }, { role: 'assistant', content: 'Is that nmol/L or mg/dL?' }];
    const { status, stderr, out, calls } = await run(fixture({ query: 'nmol/L', history, expect_roadmap_run: true }), true);
    expect(calls.length, stderr).toBe(2);
    expect(calls[0].messages).toEqual([...history, { role: 'user', content: 'nmol/L' }]);
    expect(calls[0].tools.map((t: { name: string }) => t.name)).toContain('run_roadmap');
    expect(calls[1].messages.slice(0, 3)).toEqual(calls[0].messages);
    expect(out).toContain('Fixed-handle answer checks: 1/1 ✓');
    expect(status).toBe(0);
  }, 60_000);

  it('a history that does not alternate user, assistant, ending on the assistant, exits before any API call', async () => {
    for (const history of [[{ role: 'assistant', content: 'hi' }], [{ role: 'user', content: 'a' }], 'LDL 4', [{ role: 'user', content: 3 }, { role: 'assistant', content: 'x' }]]) {
      const { status, stderr, calls } = await run(fixture({ history }), true);
      expect(stderr).toMatch(/history/);
      expect(calls).toEqual([]);
      expect(status).toBe(1);
    }
  }, 120_000);

  it('expect_roadmap_run fails an answer that did not call the tool, and one that did when it must not', async () => {
    expect((await run(fixture({ expect_roadmap_run: true, must_mention: ['plain'] }), false)).out).toContain('did not call run_roadmap');
    expect((await run(fixture({ expect_roadmap_run: false }), true)).out).toContain('called run_roadmap');
  }, 120_000);

  // US-16 AC2 (review 2026-10-20, adversary R3): the reply must propose saving the stated values.
  it('expect_profile_edit passes the stated values, fails a wrong or missing proposal, and scores an empty reply on toolOnlyAck', async () => {
    const profileRun = async (expect_profile_edit: unknown, content: unknown[], extra: Record<string, unknown> = {}) => {
      const fx = fixture({ query: "I'm a man, 165 cm", must_mention: undefined, expect_profile_edit, ...extra });
      const res = await runHarness(['--category', 'own-data-analysis', '--fixed-handles-only', '--answer-check-runs', '1', '--verbose'], {
        fixtures: [fx], fetch: async () => reply(content),
      });
      return { status: res.status, stderr: res.err, out: noColour(res.out) };
    };
    const call = (input: unknown, id = 'toolu_p') => ({ type: 'tool_use', id, name: 'propose_profile_edit', input });
    const text = { type: 'text', text: 'Press Save on the banner to keep them.' };
    const both = { sex: 'male', heightCm: 165 };
    expect((await profileRun(both, [text, call({ sex: 'male', height: { value: 165, unit: 'cm' } })])).out).toContain('Fixed-handle answer checks: 1/1 ✓');
    // Merged as the widget merges one reply's calls; 65 in is 165.1 cm, within 0.1.
    expect((await profileRun(both, [call({ sex: 'male' }), call({ height: { value: 65, unit: 'in' } }, 'toolu_q'), text])).out).toContain('1/1 ✓');
    expect((await profileRun(both, [text])).out).toContain('no propose_profile_edit');
    expect((await profileRun(both, [text, call({ sex: 'female', height: { value: 170, unit: 'cm' } })])).out)
      .toMatch(/proposed sex female, not male[\s\S]*proposed height 170 cm, not 165/);
    // A call the parser refuses (feet) proposes nothing.
    expect((await profileRun(both, [text, call({ height: { value: 5.4, unit: 'ft' } })])).out).toContain('no propose_profile_edit');
    // A tool-only reply is scored on the line the widget shows, so a must_match on it passes.
    expect((await profileRun({ heightCm: 165 }, [call({ height: { value: 165, unit: 'cm' } })], { must_match: ['press save'] })).out).toContain('1/1 ✓');
    for (const bad of [{}, { heightCm: '165' }, { sex: 'man' }, { weight: 80 }, 'yes']) {
      const { status, stderr } = await profileRun(bad, [text]);
      expect(stderr).toMatch(/expect_profile_edit must name/);
      expect(status).toBe(1);
    }
  }, 180_000);

  it('expect_roadmap_run alone still triggers the answer check (Codex PR 150 round 4)', async () => {
    expect((await run(fixture({ must_mention: undefined, expect_roadmap_run: true }), false)).out).toContain('did not call run_roadmap');
    expect((await run(fixture({ must_mention: undefined, expect_roadmap_run: false }), true)).out).toContain('called run_roadmap');
  }, 120_000);
});

// US-50 AC3: the harness builds its router view through the production
// function, so a hidden post leaves its index block and entry count too.
describe('test-chatbot-matching router view (US-50 AC3)', () => {
  it('drops a hidden post whose master is up to date from the index block and the count', async () => {
    interface Entry { handle: string; type?: string; youtube?: string; topics?: string[]; router?: string; reviewed?: string }
    const index = JSON.parse(readFileSync(join(REPO_ROOT, 'docs/blog/index.json'), 'utf-8')) as Entry[];
    for (const e of index) delete e.router; // start from a view that hides nothing, so the counts below are exact
    const m = index.find(e => e.type === 'reference')!;
    const p = index.find(e => e.youtube)!;
    m.reviewed = '2099-01-01';
    p.topics = [m.handle];
    p.router = 'hidden';
    const q = pickCase();
    const dir = mkdtempSync(join(tmpdir(), 'chatbot-view-'));
    try {
      const indexPath = join(dir, 'index.json');
      writeFileSync(indexPath, JSON.stringify(index));
      let seen: string[] = [];
      const res = await runHarness(['--category', q.category, '--runs', '1', '--index', indexPath], {
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init.body));
          if (Array.isArray(body.system)) seen = body.system.map((b: { text: string }) => b.text);
          return textReply('{"handles":[]}');
        },
      });
      const [prompt, block] = seen;
      expect(block, res.err).not.toContain(`] ${p.handle}:`);
      expect(block).toContain(`] ${m.handle}:`);
      expect(block.split('\n')).toHaveLength(index.length - 1);
      expect(prompt).toContain(`a ${index.length - 1}-entry index`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // L3 (review 2026-10-20): fixture handles are checked against the full index;
  // one the view hides is reported on its own line, and the run goes on.
  it('reports expected and must_not_route handles the view hides, without exiting', async () => {
    interface Entry { handle: string; type?: string; youtube?: string; topics?: string[]; router?: string; reviewed?: string }
    const index = JSON.parse(readFileSync(join(REPO_ROOT, 'docs/blog/index.json'), 'utf-8')) as Entry[];
    const m = index.find(e => e.type === 'reference')!;
    const [p1, p2] = index.filter(e => e.youtube);
    m.reviewed = '2099-01-01';
    for (const p of [p1, p2]) { p.topics = [m.handle]; p.router = 'hidden'; }
    const fixtures = [{ query: 'hidden handle case', category: 'view-test', expected: [p1.handle, m.handle], must_not_route: [p2.handle] }];
    const dir = mkdtempSync(join(tmpdir(), 'chatbot-hidden-'));
    try {
      const indexPath = join(dir, 'index.json');
      writeFileSync(indexPath, JSON.stringify(index));
      const res = await runHarness(['--category', 'view-test', '--runs', '1', '--index', indexPath], {
        fixtures, fetch: async () => textReply(JSON.stringify({ handles: [m.handle] })),
      });
      const out = noColour(res.out);
      expect(res.err).not.toContain('not in the index');
      expect(out, res.err).toContain(`Hidden by the router view (US-50 AC3): expected ${p1.handle}; must_not_route ${p2.handle}`);
      expect(out).toContain('Passing:     1');
      expect(res.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

// US-50 (post-review N1): an entry with `pending` is listed, not run, unless
// --include-pending is passed, so a fixture waiting on content cannot fail a run.
describe('test-chatbot-matching pending entries (US-50)', () => {
  const fixture = (query: string, pending?: string) => ({
    query, category: 'pending-test', surface: 'doctor', answer_handles: [] as string[], must_mention: ['ok'], ...(pending ? { pending } : {}),
  });

  const ARGV = ['--category', 'pending-test', '--fixed-handles-only', '--answer-check-runs', '1'];

  async function run(fixtures: object[], flags: string[] = []) {
    const calls: string[] = [];
    const res = await runHarness([...ARGV, ...flags], {
      fixtures,
      fetch: async (_url, init) => { calls.push(JSON.parse(String(init.body)).messages.at(-1).content); return textReply('ok'); },
    });
    return { status: res.status, stderr: res.err, out: noColour(res.out), calls };
  }

  it('skips a pending entry and lists it with its reason', async () => {
    const { status, stderr, out, calls } = await run([fixture('runs now'), fixture('waits', 'masters not merged')]);
    expect(calls, stderr).toEqual(['runs now']);
    expect(out).toContain('Pending (skipped; --include-pending runs them): 1');
    expect(out).toContain('[pending-test] "waits": masters not merged');
    expect(status).toBe(0);
  }, 60_000);

  it('--include-pending runs it', async () => {
    const { stderr, calls } = await run([fixture('runs now'), fixture('waits', 'masters not merged')], ['--include-pending']);
    expect(calls.sort(), stderr).toEqual(['runs now', 'waits']);
  }, 60_000);

  // CLI spawn 5 of 5: the pending listing reaches stdout, and setup's early exit 0 the real exit code.
  it('a category holding only pending entries lists them and exits 0 with no call', () => {
    const fixtures = [fixture('waits', 'masters not merged')];
    const { status, stderr, out, calls } = spawnCli(log => `
      import fs from 'node:fs';
      const read = fs.readFileSync;
      fs.readFileSync = (p, ...rest) => String(p).endsWith('tools/test-queries.json') ? ${JSON.stringify(JSON.stringify(fixtures))} : read(p, ...rest);
      globalThis.fetch = async () => { fs.appendFileSync(${JSON.stringify(log)}, '{}\\n'); throw new Error('fetch called'); };
    `, ARGV);
    expect(calls, stderr).toEqual([]);
    expect(out).toContain('[pending-test] "waits": masters not merged');
    expect(status).toBe(0);
  }, 60_000);

  it('an invalid pending entry never stops a run: it is dropped before validation (Codex, merged branch)', async () => {
    const broken = { ...fixture('broken', 'masters not merged'), answer_handles: ['no-such-handle'], must_not_match: ['(unclosed'], history: 'bad' };
    const { status, stderr, out, calls } = await run([fixture('runs now'), broken]);
    expect(stderr).not.toMatch(/would not load|do not compile|history/);
    expect(calls, stderr).toEqual(['runs now']);
    expect(out).toContain('[pending-test] "broken": masters not merged');
    expect(status).toBe(0);
  }, 60_000);

  it('the four topic-masters fixtures are pending until masters-1 merges', () => {
    const all = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/test-queries.json'), 'utf-8')) as Array<{ category: string; pending?: string }>;
    const tm = all.filter(q => q.category === 'topic-masters');
    expect(tm).toHaveLength(4);
    expect(tm.every(q => q.pending === 'US-50 masters-1 not merged')).toBe(true);
  });
});

// C1 (US-45 AC8): a fixture's `saved_chat` adds production's SAVED-CHAT block right after the
// posture, imported from app/lib/chat-save-answers.ts, and nothing else's. A youtube
// fixture always gets YouTube's. Left out, a brand fixture gets the bubble's and a doctor
// user_context fixture the widget's. A key production never sends on that surface exits.
describe('test-chatbot-matching saved_chat (C1, US-45 AC8)', () => {
  interface Entry { query: string; category: string; surface?: string; saved_chat?: string; youtube_video?: string; answer_handles?: string[]; user_context?: unknown; must_mention?: string[] }
  const all = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/test-queries.json'), 'utf-8')) as Entry[];
  const cases = all.filter(q => q.category === 'saved-chat');
  const BLOCKS: Record<string, string> = { ...SAVED_CHAT_BY_RETENTION, discord: DISCORD_SAVED_CHAT, youtube: YOUTUBE_SAVED_CHAT };

  /** Run the harness offline on the saved-chat category; `fixtures` (if given) replaces tools/test-queries.json. */
  async function run(fixtures?: Entry[]) {
    const calls: Array<{ query: string; system: string[] }> = [];
    const res = await runHarness(['--category', 'saved-chat', '--fixed-handles-only', '--answer-check-runs', '1'], {
      fixtures,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init.body));
        const system = Array.isArray(body.system) ? body.system.map((b: { text: string }) => b.text) : body.system.split('\n\n---\n\n');
        const query = body.messages.filter((m: { role: string; content: unknown }) => m.role === 'user' && typeof m.content === 'string').at(-1)?.content;
        calls.push({ query, system });
        return textReply('stub answer');
      },
    });
    return { status: res.status, stderr: res.err, calls };
  }

  it('one fixture per sentence, each answer call carrying its own block right after the posture and no other', async () => {
    expect(cases.map(q => q.saved_chat).sort()).toEqual(Object.keys(BLOCKS).sort());
    const { stderr, calls } = await run();
    expect(calls.length, stderr).toBe(cases.length);
    const seen = calls.map(({ system }) => {
      const posture = system.findIndex(t => t.startsWith('## SURFACE CONTEXT — Dr Brad education assistant'));
      expect(posture).toBeGreaterThan(0);
      const key = Object.keys(BLOCKS).find(k => system[posture + 1] === savedChatBlock(BLOCKS[k]))!;
      expect(key, system[posture + 1]?.slice(0, 80)).toBeDefined();
      for (const [other, sentence] of Object.entries(BLOCKS)) if (other !== key) expect(system.join('\n')).not.toContain(sentence);
      return key;
    });
    expect(seen.sort()).toEqual(Object.keys(BLOCKS).sort());
  }, 120_000);

  it('a fixture left without saved_chat gets the block its production route sends; the bubble may carry a context', async () => {
    const fixture = (query: string, extra: Partial<Entry>): Entry => ({ query, category: 'saved-chat', answer_handles: [], must_mention: ['x'], ...extra });
    const { stderr, calls } = await run([
      fixture('brand default', { surface: 'brand' }),
      fixture('widget default', { surface: 'doctor', user_context: {} }),
      fixture('bubble with context', { surface: 'doctor', saved_chat: 'transcript', user_context: {} }),
      fixture('doctor, no context', { surface: 'doctor' }),
    ]);
    expect(calls.length, stderr).toBe(4);
    const blocks = Object.fromEntries(calls.map(({ query, system }) =>
      [query, Object.keys(BLOCKS).find(k => system.includes(savedChatBlock(BLOCKS[k]))) ?? 'no block']));
    expect(blocks).toEqual({
      'brand default': 'transcript', 'widget default': 'question-rows', 'bubble with context': 'transcript', 'doctor, no context': 'no block',
    });
  }, 120_000);

  it.each([
    [{ surface: 'doctor', saved_chat: 'youtube' }],
    [{ surface: 'brand', saved_chat: 'question-rows' }],
    [{ surface: 'brand', user_context: {}, saved_chat: 'none' }],
    [{ surface: 'doctor', saved_chat: 'discord', user_context: {} }],
    [{ surface: 'doctor', saved_chat: 'toString' }],
    [{ saved_chat: 'none' }],
  ])('%j exits before any API call', async (extra) => {
    const { status, stderr, calls } = await run([{ query: 'is this saved?', category: 'saved-chat', answer_handles: [], must_mention: ['x'], ...extra }]);
    expect(status).toBe(1);
    expect(stderr).toMatch(/saved_chat "[^"]+" is not one production sends on surface/);
    expect(calls).toEqual([]);
  }, 120_000);
});

// Moved from the pre-split pin file (test audit TA-T02): whole-report and request-shape snapshots of
// SYNTHETIC fixtures against a synthetic three-entry index. They pin what no case above does: the
// report layout, the router's cached blocks and entry count, handle repair, a forbidden route, 500 and
// 429 replies (retried once), a refusal, the length cap, a router-only run, the --estimate call counts,
// and the setup exits for an unknown must_not_route handle, an answer handle with no file, no match,
// no key and the wrong folder. Elapsed time, latency, dollar figures and the temp folder are normalised.
describe('test-chatbot-matching report and request shapes (synthetic fixtures)', () => {
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

  type Plan = string | { status?: number; body?: string; once?: boolean; timeout?: boolean; refusal?: boolean };
  const ROUTER: Record<string, Plan> = {
    'q-pass': '{"handles":["pin-a"]}', 'q-miss': '{"handles":[]}', 'q-forbid': '{"handles":["pin-a","pin-c"]}',
    'q-empty': '{"handles":[]}', 'q-repair': 'Here: {"handles":["guideline-pin-b"]}', 'q-parse': 'no json here',
    'q-500': { status: 500, body: 'synthetic outage' }, 'q-429': { status: 429, once: true },
  };
  const ANSWER: Record<string, Plan> = {
    'q-pass': 'Alpha answer.', 'q-answer-fail': 'Beta. It lowers blood pressure. delta delta delta.',
    'q-refusal': { refusal: true }, 'q-answer-timeout': { timeout: true }, 'q-answer-429': { status: 429, once: true },
  };

  const norm = (s: string) => s
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/=== Results \([0-9.]+s\) ===/, '=== Results (<T>s) ===')
    .replace(/p50=\d+ms p90=\d+ms/g, 'p50=<T>ms p90=<T>ms')
    .replace(/\$\d+\.\d+/g, '$<N>')
    .split(REPO_ROOT).join('<ROOT>')
    .replace(/\S*chatbot-matching-pin-\w+/g, '<DIR>');

  /** One in-process run on FIXTURES (or `fixtures`) with the router and answer plans above; returns the normalised run. */
  async function harness(flags: string[], opts: { fixtures?: object[]; key?: boolean; cwd?: (dir: string) => string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'chatbot-matching-pin-'));
    try {
      const index = join(dir, 'index.json');
      writeFileSync(index, JSON.stringify(INDEX));
      const base = ['--index', index, '--model', 'claude-sonnet-5-5', '--answer-model', 'claude-sonnet-5-5'];
      const seen = new Map<string, number>();
      const calls: unknown[] = [];
      const sys = (s: string | Array<{ text: string; cache_control?: unknown }>) => typeof s === 'string'
        ? { kind: 'string', refs: s.includes('## Referenced Blog Articles'), user: s.includes('## Current User Health Data') }
        : { kind: 'blocks', n: s.length, cached: s.map(b => !!b.cache_control), user: s.some(b => b.text.includes('## Current User Health Data')) };
      const res = await runHarness([...base, ...flags], {
        fixtures: opts.fixtures ?? FIXTURES, key: opts.key, cwd: opts.cwd?.(dir),
        fetch: async (url, init) => {
          if (String(url) !== 'https://api.anthropic.com/v1/messages') throw new Error('unexpected fetch ' + url);
          const body = JSON.parse(String(init.body));
          const first = body.messages[0].content;
          const router = typeof first === 'string' && first.startsWith('Current query: ');
          const query: string = router ? first.slice(15)
            : body.messages.filter((m: { role: string; content: unknown }) => m.role === 'user' && typeof m.content === 'string').at(-1).content;
          const key = (router ? 'r:' : 'a:') + query;
          const n = (seen.get(key) ?? 0) + 1;
          seen.set(key, n);
          calls.push(router
            ? { router: query, blocks: body.system.length, cached: body.system.map((b: { cache_control?: unknown }) => !!b.cache_control),
              count: body.system[0].text.includes('a 3-entry index'), index: body.system[1].text }
            : { answer: query, system: sys(body.system), roles: body.messages.map((m: { role: string }) => m.role), tools: (body.tools ?? []).map((t: { name: string }) => t.name) });
          const plan = (router ? ROUTER : ANSWER)[query];
          if (plan && typeof plan === 'object') {
            if (plan.status && (!plan.once || n === 1)) return new Response(plan.body ?? '', { status: plan.status, headers: { 'retry-after': '0' } });
            if (plan.timeout) throw new DOMException('timed out', 'TimeoutError');
            if (plan.refusal) return reply([{ type: 'text', text: '' }], 'refusal', { stop_details: { category: 'bio' } });
          }
          if (router) return textReply(typeof plan === 'string' ? plan : '{"handles":["pin-a"]}');
          return textReply(typeof plan === 'string' ? plan : 'ok');
        },
      });
      return { status: res.status, out: norm(res.out), err: norm(res.err), calls };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('a full router and answer-check run: report, request shapes, exit code', async () => {
    const r = await harness(['--category', 'pin,pin2', '--runs', '2', '--answer-check', '--answer-check-runs', '1', '--verbose']);
    expect(r.out, r.err).toContain('=== LLM Router Test Harness ===');
    expect(r.out).toContain('Pending (skipped; --include-pending runs them): 1');
    expect(r.calls.some(c => (c as { router?: string }).router === 'q-other')).toBe(false);
    expect(r.status).toBe(1);
    expect(r).toMatchSnapshot();
  });

  it('a router-only run makes no answer call', async () => {
    const r = await harness(['--category', 'pin', '--runs', '1']);
    expect(r.calls.every(c => 'router' in (c as object)), r.err).toBe(true);
    expect(r).toMatchSnapshot();
  });

  it('--fixed-handles-only runs only the fixed-handle checks and gates on them', async () => {
    const r = await harness(['--category', 'pin,pin2', '--fixed-handles-only', '--answer-check-runs', '3', '--include-pending']);
    expect(r.calls.every(c => 'answer' in (c as object)), r.err).toBe(true);
    expect(r).toMatchSnapshot();
  });

  it('--estimate counts the router and answer calls of a routed run, with no key and no call', async () => {
    const r = await harness(['--category', 'pin,pin2', '--answer-check', '--estimate'], { key: false });
    expect(r.out, r.err).toContain('No API call made.');
    expect(r.calls).toEqual([]);
    expect(r).toMatchSnapshot();
  });

  it('an unknown must_not_route handle, an answer handle with no file, no match, no key and the wrong folder each exit before any call', async () => {
    const bad = (name: string, fixture: object, flags: string[] = []) =>
      harness(['--category', 'v', ...flags], { fixtures: [{ query: name, category: 'v', ...fixture }] });
    const runs: Record<string, Awaited<ReturnType<typeof harness>>> = {
      badForbidden: await bad('badForbidden', { expected: ['pin-a'], must_not_route: ['nope'] }),
      badFixed: await bad('badFixed', { answer_handles: ['no-such-handle'], must_mention: ['ok'] }, ['--answer-check']),
      noMatch: await harness(['--category', 'nothing-here']),
      noKey: await harness(['--category', 'pin'], { key: false }),
      wrongCwd: await harness(['--category', 'pin'], { cwd: dir => dir }),
    };
    for (const [n, r] of Object.entries(runs)) {
      expect(r.calls, n).toEqual([]);
      expect(r.status, `${n}: ${r.err}`).toBe(1);
    }
    expect(runs).toMatchSnapshot();
  });
});
