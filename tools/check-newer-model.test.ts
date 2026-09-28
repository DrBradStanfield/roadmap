import { describe, it, expect, vi, afterEach } from 'vitest';

// The pin module may land after this tool; the pure function never reads it.
vi.mock('../packages/health-core/src/models', () => ({ CHAT_MODEL: 'claude-sonnet-5' }));
import { main, newerSonnets, qualificationLines } from './check-newer-model';

// The catalogue as listed on 2026-09-29 (docs/chat-audit-2026-09-29.md §4.3),
// plus Opus and Haiku ids that must never count as a newer Sonnet.
const CATALOGUE = [
  { id: 'claude-opus-5-5', created_at: '2026-09-28T00:00:00Z' },
  { id: 'claude-sonnet-5-5', created_at: '2026-09-28T00:00:00Z' },
  { id: 'claude-haiku-5', created_at: '2026-07-15T00:00:00Z' },
  { id: 'claude-sonnet-5', created_at: '2026-06-29T00:00:00Z' },
  { id: 'claude-opus-5', created_at: '2026-06-29T00:00:00Z' },
  { id: 'claude-sonnet-4-6', created_at: '2026-02-17T00:00:00Z' },
  { id: 'claude-haiku-4-5-20251001', created_at: '2025-10-01T00:00:00Z' },
  { id: 'claude-sonnet-4-5-20250929', created_at: '2025-09-29T00:00:00Z' },
];

describe('newerSonnets (audit §4.3: the pin moves only by a qualified PR)', () => {
  it('finds Sonnet 5.5 when Sonnet 5 is pinned, and ignores Opus and Haiku', () => {
    expect(newerSonnets(CATALOGUE, 'claude-sonnet-5').map(m => m.id)).toEqual(['claude-sonnet-5-5']);
  });
  it('returns nothing when the newest Sonnet is pinned', () => {
    expect(newerSonnets(CATALOGUE, 'claude-sonnet-5-5')).toEqual([]);
  });
  it('lists every newer Sonnet, newest first, from an older pin', () => {
    expect(newerSonnets(CATALOGUE, 'claude-sonnet-4-5-20250929').map(m => m.id))
      .toEqual(['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6']);
  });
  it('does not count a Sonnet released the same moment as the pin', () => {
    const tie = [...CATALOGUE, { id: 'claude-sonnet-5-alt', created_at: '2026-06-29T00:00:00Z' }];
    expect(newerSonnets(tie, 'claude-sonnet-5').map(m => m.id)).toEqual(['claude-sonnet-5-5']);
  });
  it('throws when the pin is missing from the list, so the tool exits 1 instead of reporting nothing newer', () => {
    expect(() => newerSonnets(CATALOGUE, 'claude-sonnet-9')).toThrow(/not in the Models API list/);
  });
});

// US-15 AC18: exit 0 = nothing newer, 10 = a newer Sonnet (qualify it), 1 = a
// named gap; the printed commands qualify the answer hop only, and the router
// and classifier lines are marked for a change to those pins.
describe('check-newer-model (US-15 AC18)', () => {
  const REAL_FETCH = global.fetch;
  afterEach(() => { global.fetch = REAL_FETCH; vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  const serve = (data: unknown[], status = 200) => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ data, has_more: false, last_id: null }), { status })) as unknown as typeof fetch;
  };
  const run = async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => { lines.push(l); });
    vi.spyOn(console, 'error').mockImplementation((l: string) => { lines.push(l); });
    return { code: await main(), out: lines.join('\n') };
  };

  it('prints the answer-hop commands first and marks the router and classifier lines', () => {
    const lines = qualificationLines('claude-sonnet-6');
    const marker = lines.findIndex((l) => /only if the router or classifier pin is changed/.test(l));
    expect(marker).toBeGreaterThan(0);
    const before = lines.slice(0, marker).join('\n');
    expect(before).toContain('tools/test-chatbot-matching.ts --answer-model claude-sonnet-6 --runs 3 --answer-check');
    expect(before).toContain('tools/test-tool-edits.ts --model claude-sonnet-6');
    expect(before).not.toMatch(/test-classifier|--model claude-sonnet-6 --runs/);
    const after = lines.slice(marker).join('\n');
    expect(after).toContain('tools/test-chatbot-matching.ts --model claude-sonnet-6');
    expect(after).toContain('tools/test-classifier.ts --model claude-sonnet-6');
  });

  it('exit 10 when a newer Sonnet exists, with the commands for it', async () => {
    vi.stubEnv('ANTHROPIC_TEST_API_KEY', 'k');
    serve(CATALOGUE);
    const { code, out } = await run();
    expect(code).toBe(10);
    expect(out).toContain('--answer-model claude-sonnet-5-5');
  });

  it('exit 0 when the pin is the newest Sonnet', async () => {
    vi.stubEnv('ANTHROPIC_TEST_API_KEY', 'k');
    serve(CATALOGUE.filter((m) => m.id !== 'claude-sonnet-5-5'));
    expect((await run()).code).toBe(0);
  });

  it('names the key in use, as the harnesses do, and never prints its value', async () => {
    serve(CATALOGUE);
    vi.stubEnv('ANTHROPIC_TEST_API_KEY', 'sk-secret-test');
    let out = (await run()).out;
    expect(out).toContain('Using ANTHROPIC_TEST_API_KEY (test workspace)');
    expect(out).not.toContain('sk-secret');
    vi.stubEnv('ANTHROPIC_TEST_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-secret-prod');
    out = (await run()).out;
    expect(out).toContain('Using ANTHROPIC_API_KEY (production key — billing shared with prod)');
    expect(out).not.toContain('sk-secret');
  });

  it('exit 1 on an API error or a missing key', async () => {
    vi.stubEnv('ANTHROPIC_TEST_API_KEY', 'k');
    serve([], 500);
    expect((await run()).code).toBe(1);
    vi.stubEnv('ANTHROPIC_TEST_API_KEY', '');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect((await run()).code).toBe(1);
  });
});
