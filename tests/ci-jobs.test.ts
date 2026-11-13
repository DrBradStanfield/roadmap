/**
 * US-64 AC11 + AC12: ci.yml's shape. The suite is split over runners, and the
 * one check auto-ship waits for (`test`) must still mean "everything passed".
 * A `test` job without `if: always()` is skipped when a shard fails, and a
 * skipped job is not a red one; a shard count that disagrees with the matrix
 * silently drops or repeats test files.
 */
import { describe, it, expect } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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

  it('PRs run in UTC; main and the 03:00 nightly add a zone behind UTC; manual runs and the 12:00 nightly add Auckland to both; every test starts in a non-US language (US-64 AC22)', () => {
    const unit = job('unit');
    // A non-schedule event has no github.event.schedule: GitHub reads it as null, and null == '0 12 * * *' is false.
    const tz = (event_name: string, schedule?: string) =>
      interpolate(String(ciYaml.jobs.unit.strategy!.matrix.tz), { github: { event_name, event: schedule ? { schedule } : {} } });
    expect(tz('pull_request')).toEqual(['UTC']);
    expect(tz('push')).toEqual(['UTC', 'America/Los_Angeles']);
    expect(tz('schedule', '0 3 * * *')).toEqual(['UTC', 'America/Los_Angeles']);
    // A superset of a push run's zones: Pages and Deploy accept any green `test` on main's sha.
    // A manual run re-checks an Auckland-only failure without waiting for the 12:00 nightly.
    expect(tz('workflow_dispatch')).toEqual(['UTC', 'America/Los_Angeles', 'Pacific/Auckland']);
    expect(tz('schedule', '0 12 * * *')).toEqual(['UTC', 'America/Los_Angeles', 'Pacific/Auckland']);
    expect((ciYaml.on.schedule as { cron: string }[]).map((s) => s.cron)).toEqual(['0 3 * * *', '0 12 * * *']);
    expect(unit).toMatch(/TZ: \$\{\{ matrix\.tz \}\}/);
    const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
    expect(config).toMatch(/setupFiles: \['\.\/tests\/setup-locale\.ts'\]/);
    expect(navigator.language).toBe('en-GB');
  });
  it('`test` always runs and passes only when the checks and every shard succeeded', () => {
    const test = job('test');
    expect(test).toMatch(/if: always\(\)/);
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
    expect(ciYaml.jobs.test.if).toBe('always()');
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
 * US-46 AC18 (Claude Review volume, Brad 2026-11-12): no review on a push to a PR that carries `hold`.
 * Label events start nothing and cancel nothing: adding `hold` one second after
 * `opened` (gh pr create --label hold) used to cancel that review, leaving a
 * CANCELLED `review` that merge-gated refuses (exit 9) until a re-run.
 */
describe('claude-review.yml triggers and lane (US-46 AC18)', () => {
  const review = yaml.load(readFileSync(join(ROOT, '.github/workflows/claude-review.yml'), 'utf8')) as Workflow;
  const ctx = (action: string, labels: string[] = [], label?: string) => ({
    github: {
      run_id: '777',
      repository: 'o/r',
      event: {
        action,
        label: label ? { name: label } : undefined,
        pull_request: { number: 42, head: { ref: 'claude/x', repo: { full_name: 'o/r' } }, labels: labels.map((name) => ({ name })) },
      },
    },
  });
  const runs = (c: ReturnType<typeof ctx>) => Boolean(evalExpr(review.jobs.review.if!, c));
  const lane = (c: ReturnType<typeof ctx>) => interpolate(review.concurrency!.group, c);

  it('fires on opened and synchronize only, never a label event', () => {
    expect((review.on.pull_request as { types: string[] }).types).toEqual(['opened', 'synchronize']);
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

  it('first re-reads the live labels, and a held PR runs no review step', () => {
    const steps = (review.jobs.review as unknown as { steps: { id?: string; if?: string; uses?: string; run?: string }[] }).steps;
    expect(steps[0].id).toBe('hold');
    expect(steps[0].uses).toBeUndefined();
    expect(steps[0].run).toContain('sleep 5');
    expect(steps[0].run).toContain('issues/$PR/labels');
    expect(steps[0].run).toContain('held=true');
    // Every later step, the checkout and the paid review included, is gated on it.
    expect(steps.length).toBeGreaterThan(1);
    for (const s of steps.slice(1)) {
      const run = (held: string) => Boolean(evalExpr(s.if!, { steps: { hold: { outputs: { held } } } }));
      expect(run('true')).toBe(false);
      expect(run('')).toBe(true);
    }
    expect(steps.some((s) => s.uses?.startsWith('anthropics/claude-code-action@'))).toBe(true);
  });

  // Runs the hold step's own script (read from the YAML) under a fake `gh` and `sleep`, as
  // deploy-pages-smoke-wait.test.ts does. The fake answers one label name per line, as --jq does.
  const runHoldStep = (labels: string[] | 'gh-fails') => {
    const dir = mkdtempSync(join(tmpdir(), 'review-hold-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "$*" >> "$LOG"\n[ "$FAIL" = 1 ] && { echo "HTTP 502" >&2; exit 1; }\nprintf "%s" "$LABELS"\n');
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
    for (const f of ['gh', 'sleep']) chmodSync(join(bin, f), 0o755);
    const out = join(dir, 'output');
    const log = join(dir, 'calls.log');
    writeFileSync(out, '');
    writeFileSync(log, '');
    const steps = (review.jobs.review as unknown as { steps: { run?: string }[] }).steps;
    writeFileSync(join(dir, 'step.sh'), steps[0].run!);
    const r = spawnSync('bash', ['-e', join(dir, 'step.sh')], {
      env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, LOG: log, REPO: 'o/r', PR: '42',
        FAIL: labels === 'gh-fails' ? '1' : '0', LABELS: labels === 'gh-fails' ? '' : labels.map((l) => `${l}\n`).join('') },
      encoding: 'utf8',
    });
    return { code: r.status, stdout: r.stdout, output: readFileSync(out, 'utf8'), calls: readFileSync(log, 'utf8') };
  };

  it('the hold step marks a PR labelled exactly `hold` as held, and says so', () => {
    const r = runHoldStep(['docs', 'hold']);
    expect(r.code).toBe(0);
    expect(r.output).toBe('held=true\n');
    expect(r.stdout).toContain("Review skipped: PR 42 carries the 'hold' label.");
    expect(r.calls).toBe('api --paginate repos/o/r/issues/42/labels --jq .[].name\n');
  });

  it('labels that only contain the word, or no labels, are not held, so the review runs', () => {
    for (const labels of [['on-hold', 'hold-me'], []]) {
      const r = runHoldStep(labels);
      expect(r.code).toBe(0);
      expect(r.output).toBe('');
      expect(r.stdout).not.toContain('Review skipped');
    }
  });

  it('a failed labels read is not held, so the review runs (fails open by design)', () => {
    const r = runHoldStep('gh-fails');
    expect(r.code).toBe(0);
    expect(r.output).toBe('');
  });

  it('a newer push cancels the older review in the PR lane', () => {
    expect(review.concurrency!['cancel-in-progress']).toBe(true);
    const pr = lane(ctx('opened'));
    expect(lane(ctx('synchronize'))).toBe(pr);
    expect(pr).toBe('claude-review-42');
  });
});
