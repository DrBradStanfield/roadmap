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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
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

describe('pages.yml publishes only what CI passed (US-64 AC9)', () => {
  const pages = readFileSync(join(ROOT, '.github/workflows/pages.yml'), 'utf8');
  const wait = pages.indexOf('- name: Wait for CI to pass on the main commit being published');
  const build = pages.indexOf('- name: Build main → /');

  it('waits for ci.yml\'s test check on main before building, and builds that exact commit', () => {
    expect(wait).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(build);
    const step = pages.slice(wait, build);
    expect(step).toContain('check-runs?check_name=test');
    expect(step).toContain('[ "${path}" = ".github/workflows/ci.yml" ]');
    expect(step).toMatch(/CI failed on \$\{SHA\}; not publishing it\."; exit 1/);
    expect(step).not.toMatch(/continue-on-error/);
    expect(pages.slice(build)).toMatch(/git checkout --detach "\$\{MAIN_SHA\}"/);
    expect(pages).toMatch(/checks: read/);
    expect(pages).toMatch(/actions: read/);
  });
});
