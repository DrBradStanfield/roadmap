/**
 * US-46 AC13 (GHSA-v69g-jc5m-3993): deploy.yml runs only on a dispatch, and its
 * gate refuses any ref but main. The environment's main-only branch rule is the
 * real boundary (a branch runs its own copy of this file); this pins main's copy
 * so the deleted pull_request path cannot quietly come back.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const deploy = yaml.load(readFileSync(join(root, '.github/workflows/deploy.yml'), 'utf8')) as {
  on: Record<string, unknown>;
  jobs: Record<string, { if?: string; environment?: string; needs?: string[]; steps?: { run?: string; env?: Record<string, string> }[] }>;
};

describe('deploy.yml (US-46 AC13)', () => {
  it('has no trigger but workflow_dispatch', () => {
    expect(Object.keys(deploy.on)).toEqual(['workflow_dispatch']);
  });
  it("the gate runs only for a dispatch on refs/heads/main", () => {
    expect(deploy.jobs.gate.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(deploy.jobs.gate.if).toContain("github.ref == 'refs/heads/main'");
  });
  it('the job holding the production secrets waits on the gate', () => {
    const holders = Object.entries(deploy.jobs).filter(([, j]) => j.environment === 'production');
    expect(holders.map(([name]) => name)).toEqual(['deploy']);
    expect(holders[0][1].needs).toContain('gate');
  });
});

// A PR runs the suite in UTC only, and an auto-shipped or up-to-date merge gets
// no push CI on main, so Deploy's own run is the zone-behind-UTC run (US-64 AC22).
describe('deploy.yml full suite (US-64 AC22)', () => {
  it('runs the whole suite exactly once, in America/Los_Angeles', () => {
    const suites = Object.values(deploy.jobs)
      .flatMap((j) => j.steps ?? [])
      .filter((s) => /\bnpm\s+(run\s+)?test(:[\w:-]+)?(?![\w:-])|\bvitest\b/.test(s.run ?? ''));
    expect(suites).toHaveLength(1);
    expect(suites[0].run).toBe('npm run test:all');
    expect(suites[0].env?.TZ).toBe('America/Los_Angeles');
  });
});
