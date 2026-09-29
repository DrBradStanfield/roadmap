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
