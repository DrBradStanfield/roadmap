/**
 * US-64 AC7: the stale-PR watch flags an open PR idle over 48 hours, a draft only after 7 days. This runs the
 * workflow's own github-script block (.github/workflows/stale-pr-watch.yml) in a sandbox with a stub GitHub
 * client, so the rule is tested where it lives (a separate script file would let a push to main change what a
 * workflow token runs without touching a workflow file).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const YML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.github/workflows/stale-pr-watch.yml'), 'utf8');
// The `script: |` block, de-indented.
const lines = YML.slice(YML.indexOf('script: |') + 'script: |'.length).split('\n').slice(1);
const indent = lines[0].match(/^ */)![0].length;
const end = lines.findIndex((x) => x.trim() !== '' && !x.startsWith(' '.repeat(indent)));
const SCRIPT = lines.slice(0, end === -1 ? undefined : end).map((l) => l.slice(indent)).join('\n');

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const pr = (number: number, draft: boolean, hours: number) =>
  ({ number, draft, updated_at: hoursAgo(hours), title: `PR ${number}`, head: { ref: `claude/b${number}` }, user: { login: 'x' } });

async function run(prs: ReturnType<typeof pr>[]) {
  const created: string[] = [];
  const github = {
    paginate: async () => prs,
    rest: {
      pulls: { list: () => {} },
      search: { issuesAndPullRequests: async () => ({ data: { items: [] } }) },
      issues: { create: async (o: { body: string }) => { created.push(o.body); }, update: async () => {}, createComment: async () => {} },
    },
  };
  await runInNewContext(`(async () => {\n${SCRIPT}\n})()`, { github, context: { repo: { owner: 'o', repo: 'r' } }, Date });
  return created.length ? [...created[0].matchAll(/\| #(\d+) /g)].map((m) => Number(m[1])) : [];
}

describe('stale-pr-watch.yml (US-64 AC7)', () => {
  it('flags a non-draft after 48 hours, not before', async () => {
    expect(await run([pr(1, false, 47), pr(2, false, 49)])).toEqual([2]);
  });
  it('flags a draft only after 7 days', async () => {
    expect(await run([pr(3, true, 49), pr(4, true, 6 * 24 + 23), pr(5, true, 7 * 24 + 1)])).toEqual([5]);
  });
  it('lists the oldest first, and opens no issue when nothing is stale', async () => {
    expect(await run([pr(6, false, 50), pr(7, false, 200)])).toEqual([7, 6]);
    expect(await run([pr(8, false, 1)])).toEqual([]);
  });
});
