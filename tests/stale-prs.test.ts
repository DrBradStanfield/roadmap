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
import yaml from 'js-yaml';

const YML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '.github/workflows/stale-pr-watch.yml'), 'utf8');
// The n-th `script: |` block, de-indented.
function scriptBlock(n: number) {
  const blocks = YML.split('script: |');
  const lines = blocks[n + 1].split('\n').slice(1);
  const indent = lines[0].match(/^ */)![0].length;
  const end = lines.findIndex((x) => x.trim() !== '' && !x.startsWith(' '.repeat(indent)));
  return lines.slice(0, end === -1 ? undefined : end).map((l) => l.slice(indent)).join('\n');
}
const SCRIPT = scriptBlock(0);
const SIGN_SCRIPT = scriptBlock(1);

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

describe('stale-pr-watch.yml: an engine sign approval waiting over 12 h reaches Brad', () => {
  const TITLE = '\ud83d\udd0f Engine release waiting for signing approval';
  type Job = { name: string; status: string; conclusion: string | null };
  type Run = { id: number; html_url: string; run_started_at: string; status: string; conclusion: string | null; jobs: Job[] };
  // A run waiting at sign, one whose sign a newer run cancelled, and one stale run (fresh
  // failed, sign skipped) that a later cancel would not have reached sign in.
  const run = (id: number, hours: number, kind: 'waiting' | 'cancelled-at-sign' | 'cancelled-skipped' | 'released' = 'waiting'): Run => ({
    id, html_url: `https://github.com/o/r/actions/runs/${id}`, run_started_at: hoursAgo(hours),
    status: kind === 'waiting' ? 'waiting' : 'completed',
    conclusion: kind === 'waiting' ? null : kind === 'released' ? 'success' : 'cancelled',
    jobs: kind === 'waiting' ? [{ name: 'fresh', status: 'completed', conclusion: 'success' }, { name: 'sign', status: 'waiting', conclusion: null }]
      : kind === 'cancelled-at-sign' ? [{ name: 'fresh', status: 'completed', conclusion: 'success' }, { name: 'sign', status: 'completed', conclusion: 'cancelled' }]
      : kind === 'cancelled-skipped' ? [{ name: 'fresh', status: 'completed', conclusion: 'failure' }, { name: 'sign', status: 'completed', conclusion: 'skipped' }]
      : [{ name: 'fresh', status: 'completed', conclusion: 'success' }, { name: 'sign', status: 'completed', conclusion: 'success' }],
  });
  const LAST_RELEASE = hoursAgo(100);
  async function runSign(runs: Run[], items: Item[] = [], opts: { failLookup?: boolean } = {}) {
    const created: Created[] = [];
    const updated: Array<{ issue_number: number; state?: string; body?: string }> = [];
    const asked: Array<Record<string, unknown>> = [];
    const jobsRead: number[] = [];
    const github = {
      rest: {
        actions: {
          listWorkflowRuns: async (o: Record<string, unknown>) => {
            asked.push(o);
            return { data: { workflow_runs: o.status === 'waiting' ? runs.filter((r) => r.status === 'waiting') : runs } };
          },
          listJobsForWorkflowRun: async (o: { run_id: number }) => {
            jobsRead.push(o.run_id);
            return { data: { jobs: runs.find((r) => r.id === o.run_id)!.jobs } };
          },
        },
        repos: {
          listCommits: async (o: Record<string, unknown>) => {
            asked.push(o);
            if (opts.failLookup) throw new Error('boom');
            return { data: [{ commit: { committer: { date: LAST_RELEASE } } }] };
          },
        },
        search: { issuesAndPullRequests: async () => ({ data: { items } }) },
        issues: {
          create: async (o: Created) => { created.push(o); },
          update: async (o: { issue_number: number; state?: string; body?: string }) => { updated.push(o); },
        },
      },
    };
    const core = { warning: () => {} };
    await runInNewContext(`(async () => {\n${SIGN_SCRIPT}\n})()`, { github, core, context: { repo: { owner: 'o', repo: 'r' } }, Date });
    return { created, updated, asked, jobsRead };
  }
  const mine = { number: 11, title: TITLE, user: { login: 'github-actions[bot]' } };
  const HEAD = /^An engine release has waited over 12 hours for signing approval\. Approve or reject it: Actions → the run → Review deployments\.\n\n/;

  it('US-25 AC18b: runs even when the stale-PR step failed', () => {
    const steps = (yaml.load(YML) as { jobs: { watch: { steps: Array<{ name?: string; if?: string }> } } }).jobs.watch.steps;
    expect(steps.find((s) => s.name?.startsWith('Warn when an engine sign'))!.if).toBe('always()');
  });
  it('US-25 AC18b: no waiting run closes its open warning and looks up nothing else', async () => {
    const { created, updated, asked } = await runSign([], [mine]);
    expect(created).toEqual([]);
    expect(updated).toEqual([{ owner: 'o', repo: 'r', issue_number: 11, state: 'closed' }]);
    expect(asked).toEqual([expect.objectContaining({ workflow_id: 'engine-release.yml', status: 'waiting' })]);
  });
  it('US-25 AC18b: a single waiting run under 12 h does nothing', async () => {
    const { created, updated } = await runSign([run(1, 11)]);
    expect(created).toEqual([]);
    expect(updated).toEqual([]);
  });
  it('US-25 AC18b: a chain of runs cancelled at sign over 12 h, with a fresh waiting one, warns', async () => {
    const { created, updated, asked, jobsRead } = await runSign([run(3, 1), run(2, 20, 'cancelled-at-sign'), run(1, 30, 'cancelled-at-sign'), run(9, 25, 'released')]);
    expect(updated).toEqual([]);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ title: TITLE, assignees: ['DrBradStanfield'] });
    expect(created[0].body).toMatch(HEAD);
    expect(created[0].body).toContain(`An engine has been waiting for approval since ${hoursAgo(30).slice(0, 13)}`);
    expect(created[0].body).toContain('/actions/runs/3 ');
    expect(created[0].body).not.toContain('/actions/runs/1 ');
    // One commits call on the release folder, runs since that commit (bounded), and jobs
    // only for runs that are waiting or cancelled.
    expect(asked).toContainEqual(expect.objectContaining({ sha: 'main', path: 'ios/engine-release', per_page: 1 }));
    expect(asked).toContainEqual(expect.objectContaining({ workflow_id: 'engine-release.yml', created: `>${LAST_RELEASE}`, per_page: 30 }));
    expect(jobsRead.sort()).toEqual([1, 2, 3]);
  });
  it('US-25 AC18b: a cancelled run whose sign was skipped does not count', async () => {
    const { created, updated } = await runSign([run(3, 1), run(1, 30, 'cancelled-skipped')]);
    expect(created).toEqual([]);
    expect(updated).toEqual([]);
  });
  it('US-25 AC18b: if the lookup fails, it times the waiting run alone', async () => {
    const late = await runSign([run(3, 13), run(1, 30, 'cancelled-at-sign')], [], { failLookup: true });
    expect(late.created).toHaveLength(1);
    expect(late.created[0].body).toContain(`since ${hoursAgo(13).slice(0, 13)}`);
    const early = await runSign([run(3, 1), run(1, 30, 'cancelled-at-sign')], [], { failLookup: true });
    expect(early.created).toEqual([]);
  });
  it('US-25 AC18b: a second pass updates its issue and opens no second one', async () => {
    const { created, updated } = await runSign([run(2, 37)], [mine]);
    expect(created).toEqual([]);
    expect(updated).toHaveLength(1);
    expect(updated[0].issue_number).toBe(11);
    expect(updated[0].state).toBeUndefined();
    expect(updated[0].body).toMatch(HEAD);
    expect(updated[0].body).toContain('/actions/runs/2 ');
  });
  it('US-25 AC18b: never updates a look-alike issue someone else opened', async () => {
    const { created, updated } = await runSign([run(3, 13)], [{ ...mine, user: { login: 'mallory' } }]);
    expect(updated).toEqual([]);
    expect(created).toHaveLength(1);
  });
});
