/**
 * US-64 AC11 + AC12: ci.yml's shape. The suite is split over runners, and the
 * one check auto-ship waits for (`test`) must still mean "everything passed".
 * A `test` job without `if: always()` is skipped when a shard fails, and a
 * skipped job is not a red one; a shard count that disagrees with the matrix
 * silently drops or repeats test files.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { interpolate, evalExpr } from './gh-expr';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ciText = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
type Workflow = {
  on: Record<string, unknown>;
  concurrency?: { group: string; 'cancel-in-progress'?: boolean };
  jobs: Record<string, { if?: string; needs?: string[]; 'timeout-minutes'?: number; strategy?: { matrix: Record<string, unknown> } }>;
};
const ciYaml = yaml.load(ciText) as Workflow;
const ci = ciText
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');

/** The text of one top-level job, from its `  name:` line to the next job. */
const job = (name: string) => {
  const m = ci.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z-]+:\\n|(?![\\s\\S]))`, 'm'));
  if (!m) throw new Error(`no job ${name}`);
  return m[1];
};

describe('ci.yml jobs (US-64 AC12)', () => {
  it('splits the whole suite over exactly as many shards as the matrix runs', () => {
    const unit = job('unit');
    const shards = unit.match(/shard: \[([\d, ]+)\]/)![1].split(',').map((n) => Number(n.trim()));
    const total = Number(unit.match(/npm run test:all -- --shard=\$\{\{ matrix\.shard \}\}\/(\d+)/)![1]);
    expect(shards).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect(unit).toMatch(/fail-fast: false/);
  });

  it('PRs run in UTC; main, manual and nightly runs add a zone behind UTC; every test starts in a non-US language (US-64 AC22)', () => {
    const unit = job('unit');
    const tz = (event_name: string) => interpolate(String(ciYaml.jobs.unit.strategy!.matrix.tz), { github: { event_name } });
    expect(tz('pull_request')).toEqual(['UTC']);
    for (const event of ['push', 'workflow_dispatch', 'schedule']) {
      expect(tz(event), event).toEqual(['UTC', 'America/Los_Angeles']);
    }
    expect(ciYaml.on).toHaveProperty('schedule');
    expect((ciYaml.on.schedule as { cron: string }[]).length).toBe(1);
    expect(unit).toMatch(/TZ: \$\{\{ matrix\.tz \}\}/);
    const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
    expect(config).toMatch(/setupFiles: \['\.\/tests\/setup-locale\.ts'\]/);
    expect(navigator.language).toBe('en-GB');
  });
  it('`test` always runs (but on a draft PR) and passes only when the checks and every shard succeeded', () => {
    const test = job('test');
    expect(test).toMatch(/if: always\(\) && /);
    expect(test).toMatch(/needs: \[checks, unit\]/);
    expect(test).toContain('CHECKS: ${{ needs.checks.result }}');
    expect(test).toContain('UNIT: ${{ needs.unit.result }}');
    expect(test).toMatch(/\[ "\$\{CHECKS\}" = success \] && \[ "\$\{UNIT\}" = success \]/);
    // A job or step allowed to fail reports success to `needs`, so `test` would go green over a red shard.
    expect(job('checks')).not.toMatch(/continue-on-error/);
    expect(job('unit')).not.toMatch(/continue-on-error/);
  });

  it('a newer push to a PR cancels its older run; main, manual and nightly runs each get their own lane (US-46 AC18)', () => {
    const lane = (event_name: string, number?: number) =>
      interpolate(ciYaml.concurrency!.group, {
        github: { event_name, run_id: '777', event: number ? { pull_request: { number } } : {} },
      });
    expect(ciYaml.concurrency!['cancel-in-progress']).toBe(true);
    expect(lane('pull_request', 42)).toBe('ci-42');
    for (const event of ['push', 'workflow_dispatch', 'schedule']) expect(lane(event), event).toBe('ci-777');
  });

  it('every job has a time limit, so a hung runner frees its slot (US-46 AC18)', () => {
    for (const [name, j] of Object.entries(ciYaml.jobs)) {
      expect(j['timeout-minutes'], name).toBeGreaterThan(0);
    }
    expect(ciYaml.jobs.test.needs).toEqual(['checks', 'unit']);
  });

  it('the checks job keeps every gate the single job had, plus the story gate (AC11)', () => {
    const checks = job('checks');
    for (const step of [
      'npm run rebuild-index',
      'npx audit-ci@',
      '/tmp/gitleaks dir .',
      'npx tsc --noEmit -p widget-src/tsconfig.json',
      'npx tsc --noEmit -p packages/health-core/tsconfig.json',
      'npm run typecheck:server',
      'npm run typecheck:engine',
      'npm run build\n',
      'npm run build:widget',
      'scripts/build-user-stories-html.ts --check-against "${BASE}"',
    ]) {
      expect(checks, step).toContain(step);
    }
    expect(checks).toContain('BASE: ${{ github.event.pull_request.base.sha || github.event.before }}');
    expect(checks).not.toContain('test:all');
  });
});

/**
 * US-46 AC19 (Brad 2026-11-12): CI does not run on a draft PR. A session pushes
 * to a draft as it goes; marking it ready (`ready_for_review`) starts the real
 * run on the head sha. Converting a PR back to a draft joins the PR's lane, so
 * it cancels a run in flight, and its own run skips every job. Pushes to main,
 * manual and nightly runs are untouched.
 */
describe('ci.yml skips draft PRs (US-46 AC19)', () => {
  type Case = { name: string; event_name: string; action?: string; draft?: boolean };
  const ctx = (c: Case) => ({
    github: {
      event_name: c.event_name,
      run_id: '777',
      event:
        c.event_name === 'pull_request'
          ? { action: c.action, pull_request: { number: 42, draft: c.draft, head: { sha: 'abc123' } } }
          : {},
    },
  });
  const runs = (jobName: string, c: Case) => Boolean(evalExpr(ciYaml.jobs[jobName].if!, ctx(c)));
  const real: Case[] = [
    { name: 'push to main', event_name: 'push' },
    { name: 'nightly', event_name: 'schedule' },
    { name: 'manual', event_name: 'workflow_dispatch' },
    { name: 'ready PR opened', event_name: 'pull_request', action: 'opened', draft: false },
    { name: 'push to a ready PR', event_name: 'pull_request', action: 'synchronize', draft: false },
    { name: 'reopened ready PR', event_name: 'pull_request', action: 'reopened', draft: false },
    { name: 'draft marked ready', event_name: 'pull_request', action: 'ready_for_review', draft: false },
  ];
  const skipped: Case[] = [
    { name: 'draft opened', event_name: 'pull_request', action: 'opened', draft: true },
    { name: 'push to a draft', event_name: 'pull_request', action: 'synchronize', draft: true },
    { name: 'reopened draft', event_name: 'pull_request', action: 'reopened', draft: true },
    { name: 'converted to draft', event_name: 'pull_request', action: 'converted_to_draft', draft: true },
  ];

  it('fires on the PR events that change what is ready, and still on main, manual and nightly', () => {
    expect((ciYaml.on.pull_request as { types: string[]; branches: string[] }).types).toEqual([
      'opened',
      'synchronize',
      'reopened',
      'ready_for_review',
      'converted_to_draft',
    ]);
    expect((ciYaml.on.pull_request as { branches: string[] }).branches).toEqual(['main']);
    expect(ciYaml.on.push).toEqual({ branches: ['main'] });
    expect(ciYaml.on).toHaveProperty('workflow_dispatch');
  });

  for (const jobName of ['checks', 'unit', 'test']) {
    it(`${jobName} runs on every non-draft event and on none of the draft ones`, () => {
      for (const c of real) expect(runs(jobName, c), c.name).toBe(true);
      for (const c of skipped) expect(runs(jobName, c), c.name).toBe(false);
    });
  }

  it('`test` still runs after a failed or skipped check on a real run, so a red shard reads red', () => {
    // always() keeps it running whatever `checks` and `unit` ended as; the draft
    // test is the only other part, and its shell step still demands both succeeded.
    expect(ciYaml.jobs.test.if).toMatch(/^always\(\) && \(/);
    expect(ciYaml.jobs.test.if!.replace(/^always\(\) && /, '')).toBe(`(${ciYaml.jobs.checks.if})`);
    expect(ciYaml.jobs.unit.if).toBe(ciYaml.jobs.checks.if);
    expect(ciYaml.jobs.test.needs).toEqual(['checks', 'unit']);
  });

  it('a draft opened then marked ready with no push gets exactly one real run', () => {
    // GitHub runs a pull_request run on the PR's head (its test merge), so the
    // ready_for_review run tests the same commit the draft runs skipped.
    const sequence = [skipped[0], real[6]];
    for (const jobName of ['checks', 'unit', 'test']) {
      expect(sequence.filter((c) => runs(jobName, c)).map((c) => c.name), jobName).toEqual(['draft marked ready']);
    }
  });

  it('converting to a draft and marking ready share the PR lane, so the conversion cancels a run in flight', () => {
    expect(ciYaml.concurrency!['cancel-in-progress']).toBe(true);
    for (const c of [...real, ...skipped].filter((x) => x.event_name === 'pull_request')) {
      expect(interpolate(ciYaml.concurrency!.group, ctx(c)), c.name).toBe('ci-42');
    }
  });
});

/**
 * US-46 AC18 (Claude Review volume, Brad 2026-11-12): no review while a PR carries `hold`.
 * Adding `hold` cancels a running review through the shared lane; a label
 * event never runs one; any other label gets its own lane, so it cancels
 * nothing. Removing `hold` does nothing, as before (no `unlabeled` trigger).
 */
describe('claude-review.yml triggers and lane (US-46 AC18)', () => {
  const review = yaml.load(readFileSync(join(ROOT, '.github/workflows/claude-review.yml'), 'utf8')) as Workflow;
  const ctx = (action: string, labels: string[] = [], label?: string, draft = false) => ({
    github: {
      run_id: '777',
      repository: 'o/r',
      event: {
        action,
        label: label ? { name: label } : undefined,
        pull_request: {
          number: 42,
          draft,
          head: { ref: 'claude/x', repo: { full_name: 'o/r' } },
          labels: labels.map((name) => ({ name })),
        },
      },
    },
  });
  const runs = (c: ReturnType<typeof ctx>) => Boolean(evalExpr(review.jobs.review.if!, c));
  const lane = (c: ReturnType<typeof ctx>) => interpolate(review.concurrency!.group, c);

  it('fires on opened, synchronize, ready_for_review and labeled only', () => {
    expect((review.on.pull_request as { types: string[] }).types).toEqual(['opened', 'synchronize', 'ready_for_review', 'labeled']);
  });

  it('never reviews a draft; reviews a ready PR on opened, synchronize and ready_for_review, unless held (US-46 AC19)', () => {
    const actions = ['opened', 'synchronize', 'ready_for_review', 'labeled', 'converted_to_draft'];
    const pushes = ['opened', 'synchronize', 'ready_for_review'];
    for (const draft of [true, false]) {
      for (const held of [true, false]) {
        for (const action of actions) {
          const labels = held ? ['hold'] : [];
          const label = action === 'labeled' ? (held ? 'hold' : 'docs') : undefined;
          const want = !draft && !held && pushes.includes(action);
          expect(runs(ctx(action, labels, label, draft)), `draft=${draft} hold=${held} ${action}`).toBe(want);
        }
      }
    }
    // Opened as a draft, then marked ready with no push: one review.
    expect([ctx('opened', [], undefined, true), ctx('ready_for_review')].filter(runs)).toHaveLength(1);
    // The verdict pins the head sha of the event that ran it.
    expect(JSON.stringify(review.jobs.review)).toContain('VERDICT: APPROVE ${{ github.event.pull_request.head.sha }}');
  });

  it('marking ready reviews in the PR lane, so a later push or hold cancels it', () => {
    expect(lane(ctx('ready_for_review'))).toBe(lane(ctx('synchronize')));
  });

  it('reviews opened and synchronize, never a held PR, never a label event', () => {
    expect(runs(ctx('opened'))).toBe(true);
    expect(runs(ctx('synchronize', ['docs']))).toBe(true);
    expect(runs(ctx('synchronize', ['hold']))).toBe(false);
    expect(runs(ctx('opened', ['hold']))).toBe(false);
    expect(runs(ctx('labeled', ['hold'], 'hold'))).toBe(false);
    expect(runs(ctx('labeled', ['docs'], 'docs'))).toBe(false);
    // The branch and same-repo gates still hold.
    const fork = ctx('opened');
    fork.github.event.pull_request.head.repo.full_name = 'someone/else';
    expect(runs(fork)).toBe(false);
    const human = ctx('opened');
    human.github.event.pull_request.head.ref = 'feature/x';
    expect(runs(human)).toBe(false);
  });

  it('pushes and adding hold share the PR lane (and cancel); any other label gets the run id', () => {
    expect(review.concurrency!['cancel-in-progress']).toBe(true);
    const pr = lane(ctx('opened'));
    expect(lane(ctx('synchronize'))).toBe(pr);
    expect(lane(ctx('labeled', ['hold'], 'hold'))).toBe(pr);
    expect(lane(ctx('labeled', ['docs'], 'docs'))).not.toBe(pr);
    expect(lane(ctx('labeled', ['docs'], 'docs'))).toContain('777');
    expect(pr).toContain('42');
  });
});
