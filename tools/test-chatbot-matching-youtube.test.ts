/**
 * US-15 AC56: the shared answer harness can check YouTube bot replies, follow-up
 * turns included. A 'youtube' fixture is answered with the prompt runPipeline
 * builds: production's buildYouTubePlatformContext (its follow-up block when
 * the fixture has history), the doctor posture, buildConversationMessages and
 * no tools. Offline: fetch is stubbed in a real subprocess, no call leaves the
 * machine, and the stub records every request so the test reads what was sent.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT, tsxSpawn } from './test-helpers';

interface Entry { query: string; category: string; surface?: string; youtube_video?: string; history?: unknown[] }
const all = JSON.parse(readFileSync(join(REPO_ROOT, 'tools/test-queries.json'), 'utf-8')) as Entry[];
const cases = all.filter(q => q.category === 'youtube-followup');
const VIDEO_ID = (JSON.parse(readFileSync(join(REPO_ROOT, 'docs/blog/index.json'), 'utf-8')) as Array<{ handle: string; youtube?: string }>)
  .find(e => e.handle === cases[0].youtube_video)!.youtube!.match(/(?:v=|youtu\.be\/)([\w-]{11})/)![1];
const POSTURE_START = readFileSync(join(REPO_ROOT, 'app/lib/chat-posture-doctor.md'), 'utf-8').trim().slice(0, 120);

describe('test-chatbot-matching surface "youtube" (US-15 AC56)', () => {
  it('sends production\'s YouTube follow-up prompt, with no tools, and scores the replies', () => {
    expect(cases.length).toBeGreaterThanOrEqual(5);
    expect(cases.every(q => q.surface === 'youtube' && q.youtube_video && q.history?.length)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'chatbot-youtube-'));
    try {
      const stub = join(dir, 'fetch-stub.mjs');
      const log = join(dir, 'requests.jsonl');
      // A reply each fixture passes on: Step 0's emergency or crisis line, a skip for the hostile one.
      writeFileSync(stub, `
        import { appendFileSync } from 'node:fs';
        globalThis.fetch = async (_url, init) => {
          const body = JSON.parse(init.body);
          appendFileSync(${JSON.stringify(log)}, JSON.stringify(body) + '\\n');
          const q = body.messages.at(-1).content;
          const text = /shill/.test(q) ? 'SKIP_NO_REPLY'
            : /die/.test(q) ? 'Please call 1737 now, or your local emergency number.'
            : /diabetes/.test(q) ? 'With diabetes the same home target usually applies.'
            : 'Call your local emergency number now: 111 in NZ, 911 in the US.';
          return new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }),
            { status: 200, headers: { 'content-type': 'application/json' } });
        };
      `);
      const [bin, args] = tsxSpawn(['--import', stub, 'tools/test-chatbot-matching.ts',
        '--category', 'youtube-followup', '--fixed-handles-only', '--runs', '1']);
      const { ANTHROPIC_API_KEY: _live, ...rest } = process.env; // never a real key: no call leaves the machine
      const res = spawnSync(bin, args, { cwd: REPO_ROOT, env: { ...rest, ANTHROPIC_TEST_API_KEY: 'stub' }, encoding: 'utf-8', timeout: 60_000 });
      const out = res.stdout.replace(/\x1b\[[0-9;]*m/g, '');
      expect(out, res.stderr).toContain(`Fixed-handle answer checks: ${cases.length}/${cases.length}`);
      expect(res.status).toBe(0);

      const sent = readFileSync(log, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      expect(sent).toHaveLength(cases.length);
      for (const body of sent) {
        const system = JSON.stringify(body.system);
        expect(system).toContain('FOLLOW-UP TURN');
        expect(system).toContain('Step 0 still comes first');
        expect(system).toContain(JSON.stringify(POSTURE_START).slice(1, -1));
        expect(body.tools).toBeUndefined();
        // The thread as runPipeline sends it: the original comment, the bot's reply, then the follow-up.
        expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user']);
        // The comment itself, raw, as production sends it: only history turns carry a "Name: " prefix.
        expect(cases.map(c => c.query)).toContain(body.messages[2].content);
        expect(body.messages[2].content).not.toMatch(/^Viewer: /);
        expect(body.messages[0].content).toMatch(/^Viewer: /);
        // The real video's link, as production fills {{VIDEO_URL}}.
        expect(system).toContain(`https://youtu.be/${VIDEO_ID}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

});
