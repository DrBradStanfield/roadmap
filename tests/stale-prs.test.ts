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

type Created = { body: string; assignees?: string[] };
type Item = { number: number; title: string; user: { login: string }; assignees?: Array<{ login: string }> };
async function runRaw(prs: ReturnType<typeof pr>[], items: Item[] = []) {
  const created: Created[] = [];
  const updated: number[] = [];
  const assigned: number[] = [];
  const github = {
    paginate: async () => prs,
    rest: {
      pulls: { list: () => {} },
      search: { issuesAndPullRequests: async () => ({ data: { items } }) },
      issues: {
        create: async (o: Created) => { created.push(o); },
        update: async (o: { issue_number: number }) => { updated.push(o.issue_number); },
        createComment: async () => {},
        addAssignees: async (o: { issue_number: number }) => { assigned.push(o.issue_number); },
      },
    },
  };
  await runInNewContext(`(async () => {\n${SCRIPT}\n})()`, { github, context: { repo: { owner: 'o', repo: 'r' } }, Date });
  return { created, updated, assigned };
}
async function run(prs: ReturnType<typeof pr>[]) {
  const { created } = await runRaw(prs);
  return created.length ? [...created[0].body.matchAll(/\| #(\d+) /g)].map((m) => Number(m[1])) : [];
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

describe('stale-pr-watch.yml: the issue reaches Brad and outsider text stays inert (GHSA-rmrp-qfvm-jf2p)', () => {
  const TITLE = '⏳ Stale pull requests (idle over 48h)';
  it('assigns the new issue to Brad, since a bot issue alone emails nobody', async () => {
    const { created } = await runRaw([pr(1, false, 49)]);
    expect(created[0].assignees).toEqual(['DrBradStanfield']);
  });
  it('escapes a PR title and branch so they cannot ping, link or break the table', async () => {
    const evil = { ...pr(2, false, 49), title: '@DrBradStanfield [click](https://x.example) | <b>', head: { ref: 'fork@x' } };
    const { created } = await runRaw([evil]);
    const row = created[0].body.split('\n').find((l) => l.startsWith('| #2 '))!;
    expect(row).not.toMatch(/(^|[^\u200b])@DrBradStanfield/);
    expect(row).toContain('@\u200bDrBradStanfield');
    expect(row).toContain('\\[click\\](https:\u200b//x.example) \\| \\<b\\>');
    expect(row).toContain('fork@\u200bx');
  });
  it('never updates a look-alike issue someone else opened; it opens its own', async () => {
    const { created, updated } = await runRaw([pr(3, false, 49)], [{ number: 9, title: TITLE, user: { login: 'mallory' } }]);
    expect(updated).toEqual([]);
    expect(created).toHaveLength(1);
  });
  it('control: it refreshes its own issue, and assigns Brad to one opened before assignment existed', async () => {
    const { created, updated, assigned } = await runRaw([pr(4, false, 49)], [{ number: 7, title: TITLE, user: { login: 'github-actions[bot]' } }]);
    expect(updated).toEqual([7]);
    expect(created).toEqual([]);
    expect(assigned).toEqual([7]);
    const again = await runRaw([pr(4, false, 49)], [{ number: 7, title: TITLE, user: { login: 'github-actions[bot]' }, assignees: [{ login: 'DrBradStanfield' }] }]);
    expect(again.assigned).toEqual([]);
  });
  it('breaks bare URLs, which GitHub autolinks (Codex R3)', async () => {
    const { created } = await runRaw([{ ...pr(5, false, 49), title: 'see https://x.example and www.y.example' }]);
    const row = created[0].body.split('\n').find((l) => l.startsWith('| #5 '))!;
    expect(row).not.toContain('https://');
    expect(row).not.toMatch(/www\./i);
    expect(row).toContain('https:\u200b//x.example');
  });
});
