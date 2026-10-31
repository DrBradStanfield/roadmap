/**
 * deploy.yml's `deploy` job holds every production credential (Fly, Shopify,
 * Sentry). It had no `permissions:` block and the workflow has none at the top,
 * so its GITHUB_TOKEN got the repository default, while the gate and
 * verify-live jobs scope theirs. Housekeeping (no user-facing behaviour): the
 * job's token may only read the repository, which is all its checkout needs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lines = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8').split('\n');

// Each job's lines: from its two-space key under `jobs:` to the next one.
const jobs: Record<string, string[]> = {};
let current: string | null = null;
let inJobs = false;
for (const line of lines) {
  if (/^\S/.test(line)) { inJobs = line === 'jobs:'; current = null; continue; }
  const key = inJobs && line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
  if (key) { current = key[1]; jobs[current] = []; continue; }
  if (current) jobs[current].push(line);
}
const code = (job: string[]) => job.filter((l) => !l.trim().startsWith('#'));
// The job-level `permissions:` map (four-space key, six-space entries).
function permissions(job: string[]): Record<string, string> | undefined {
  const body = code(job);
  const at = body.findIndex((l) => /^ {4}permissions:\s*$/.test(l));
  if (at < 0) return undefined;
  const out: Record<string, string> = {};
  for (const l of body.slice(at + 1)) {
    const m = l.match(/^ {6}([a-z-]+):\s*([a-z]+)\s*(#.*)?$/);
    if (!m) break;
    out[m[1]] = m[2];
  }
  return out;
}

describe('deploy.yml token permissions', () => {
  it('finds the jobs (guards against a parser that sees nothing)', () => {
    expect(Object.keys(jobs)).toEqual(expect.arrayContaining(['gate', 'pages-smoke', 'deploy', 'verify-live']));
  });

  it('the deploy job token can only read the repository', () => {
    expect(permissions(jobs.deploy)).toEqual({ contents: 'read' });
  });

  it('every job that reads a secret scopes its own token', () => {
    const withSecrets = Object.keys(jobs).filter((n) => code(jobs[n]).some((l) => l.includes('secrets.')));
    expect(withSecrets).toContain('deploy');
    for (const n of withSecrets) expect(permissions(jobs[n]), n).toBeDefined();
  });
});
