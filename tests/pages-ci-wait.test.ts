// US-64 AC9: Pages publishes only a main commit CI passed. Runs the real
// "Wait for CI" step from pages.yml in a scratch git repo, under a fake `gh`
// that answers check runs per commit from a scenario file, with `sleep` stubbed.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PAGES = readFileSync(join(__dirname, '..', '.github', 'workflows', 'pages.yml'), 'utf8');
const STEP = '- name: Wait for CI to pass on the main commit being published';

/** The step's `run: |` block, dedented. */
function stepScript(): string {
  const lines = PAGES.split('\n');
  const at = lines.findIndex((l) => l.trim() === STEP);
  expect(at).toBeGreaterThan(-1);
  const run = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  const body: string[] = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() !== '' && !l.startsWith('          ')) break;
    body.push(l.slice(10));
  }
  return body.join('\n');
}

// check-runs answer from .runs[<sha>] (a list of conclusions, null = pending); the
// workflow path of every suite is .path (ci.yml unless a scenario says otherwise).
const FAKE_GH = `#!/usr/bin/env bash
shift; p=\${1#repos/o/r/}; shift; jqe=""
while [ $# -gt 0 ]; do case "$1" in --jq) jqe=$2; shift 2;; *) shift;; esac; done
out() { if [ -n "$jqe" ]; then jq -r "$jqe"; else cat; fi; }
case "$p" in
  commits/*/check-runs*) sha=\${p#commits/}; sha=\${sha%%/*}
    jq -c --arg s "$sha" '{check_runs:[(.runs[$s] // [])[] | {app:{slug:"github-actions"},conclusion:.,check_suite:{id:1}}]}' "$SCEN" | out;;
  actions/runs*) jq -c '{workflow_runs:[{path:(.path // ".github/workflows/ci.yml")}]}' "$SCEN" | out;;
  *) echo "unexpected: $p" >&2; exit 9;;
esac
`;

type Repo = { dir: string; git: (...a: string[]) => string; commit: (file: string, text: string) => string };

function scratchRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'pages-wait-'));
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  const commit = (file: string, text: string) => {
    writeFileSync(join(dir, file), text);
    git('add', file);
    git('commit', '-q', '-m', file);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

function runStep(repo: Repo, scen: { runs: Record<string, (string | null)[]>; path?: string }) {
  const bin = join(repo.dir, '.bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'sleep'), 0o755);
  const scenFile = join(repo.dir, '.scen.json');
  const envFile = join(repo.dir, '.github_env');
  writeFileSync(scenFile, JSON.stringify(scen));
  writeFileSync(envFile, '');
  writeFileSync(join(repo.dir, '.step.sh'), stepScript());
  const r = spawnSync('bash', [join(repo.dir, '.step.sh')], {
    cwd: repo.dir,
    env: { PATH: `${bin}:${process.env.PATH}`, GH_TOKEN: 'x', GITHUB_REPOSITORY: 'o/r', GITHUB_ENV: envFile, SCEN: scenFile },
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout + r.stderr, env: readFileSync(envFile, 'utf8') };
}

/** origin/main at `sha`, as the Pages checkout sees it. */
const publish = (repo: Repo, sha: string) => repo.git('update-ref', 'refs/remotes/origin/main', sha);

describe('pages.yml waits for CI before publishing main (US-64 AC9)', () => {
  it('publishes a main commit whose ci.yml test passed, and pins the build to it', () => {
    const repo = scratchRepo();
    try {
      const sha = repo.commit('a.txt', '1');
      publish(repo, sha);
      const r = runStep(repo, { runs: { [sha]: ['success'] } });
      expect(r.code, r.out).toBe(0);
      expect(r.env).toBe(`MAIN_SHA=${sha}\n`);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('refuses a main commit whose test failed', () => {
    const repo = scratchRepo();
    try {
      const sha = repo.commit('a.txt', '1');
      publish(repo, sha);
      const r = runStep(repo, { runs: { [sha]: ['failure'] } });
      expect(r.code).toBe(1);
      expect(r.out).toContain(`CI failed on ${sha}; not publishing ${sha}`);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('does not take a green test from another workflow, and gives up rather than publishing', () => {
    const repo = scratchRepo();
    try {
      const sha = repo.commit('a.txt', '1');
      publish(repo, sha);
      const r = runStep(repo, { runs: { [sha]: ['success'] }, path: '.github/workflows/evil.yml' });
      expect(r.code).toBe(1);
      expect(r.out).toContain('Timed out waiting for CI');
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it("publishes an auto-ship merge (no CI run of its own) when its tree is its PR head's and the head's test passed", () => {
    const repo = scratchRepo();
    try {
      const base = repo.commit('a.txt', '1');
      repo.git('checkout', '-q', '-b', 'pr');
      const head = repo.commit('b.txt', 'pr'); // up to date with main, as auto-ship leaves it
      repo.git('checkout', '-q', 'main');
      repo.git('merge', '-q', '--no-ff', '--no-edit', 'pr');
      const merge = repo.git('rev-parse', 'HEAD');
      expect(repo.git('rev-parse', 'HEAD^1')).toBe(base);
      publish(repo, merge);
      const r = runStep(repo, { runs: { [head]: ['success'] } });
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain(`CI passed on ${head} (publishing ${merge})`);
      expect(r.env).toBe(`MAIN_SHA=${merge}\n`);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it("never takes the PR head's run for a merge that changed the code (main had moved on)", () => {
    const repo = scratchRepo();
    try {
      repo.commit('a.txt', '1');
      repo.git('checkout', '-q', '-b', 'pr');
      const head = repo.commit('b.txt', 'pr');
      repo.git('checkout', '-q', 'main');
      repo.commit('c.txt', 'main moved'); // the merge now holds code the head's CI never saw
      repo.git('merge', '-q', '--no-ff', '--no-edit', 'pr');
      const merge = repo.git('rev-parse', 'HEAD');
      publish(repo, merge);
      const r = runStep(repo, { runs: { [head]: ['success'] } });
      expect(r.code).toBe(1);
      expect(r.out).toContain(`Timed out waiting for CI on ${merge}`);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });

  it('waits through a pending run, and the build step checks out the pinned commit', () => {
    const repo = scratchRepo();
    try {
      const sha = repo.commit('a.txt', '1');
      publish(repo, sha);
      // Pending forever: the step keeps polling and times out, never publishing on a pending run.
      const r = runStep(repo, { runs: { [sha]: [null] } });
      expect(r.code).toBe(1);
      expect(r.out).toContain('Timed out');
      const build = PAGES.slice(PAGES.indexOf(STEP));
      expect(build).toMatch(/- name: Build main → \/\n\s+run: \|\n\s+git checkout --detach "\$\{MAIN_SHA\}"/);
      expect(PAGES).toMatch(/checks: read/);
      expect(PAGES).toMatch(/actions: read/);
    } finally {
      rmSync(repo.dir, { recursive: true, force: true });
    }
  });
});
