/**
 * US-64 AC34: before it merges, merge-gated.sh refuses a PR that touches a generated file or its inputs (old and new
 * paths of a rename both count) when main has changed that file or its generator script since the PR's base, so the
 * PR's CI never saw them together. Main's input-only changes pass: main's CI keeps main's output fresh. Why: PR 954
 * changed scrub-vocabulary.ts and ran green against a main that did not yet have the instrument-scrub generator;
 * after the merge main went red with a stale output. The rule is pure git: step 6 runs nothing but gh, git, jq
 * and perl (owner's ruling, 2026-11-13: running a check there ran PR-controlled code on Brad's Mac).
 *
 * The pins read the real manifest, tools/generated-files.json. The behaviour tests run the real script from a
 * caller's clone of a throwaway origin whose main holds a byte copy of it and a test manifest. PATH holds only a
 * stub `gh` (answers from fixture JSON through the script's own --jq filters) and logging wrappers for the few
 * binaries the script may run, so any other binary (node, npx, cmp) is not found, and every call is recorded.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain .mjs tool with no declarations.
import { COMMAND, generate, realVocabulary } from './generate-instrument-scrub.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TOOLS, '..');
type Row = { output: string; script: string; inputs: string[]; generator: string };
const MANIFEST: { rows: Row[] } = JSON.parse(readFileSync(join(TOOLS, 'generated-files.json'), 'utf8'));
// The script matches as a git pathspec does: * also matches a slash.
const globRe = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');

describe('US-64 AC34 tools/generated-files.json', () => {
  it('has a row for every tools/generate-*.mjs', () => {
    const generators = readdirSync(TOOLS).filter((f) => /^generate-.*\.mjs$/.test(f));
    expect(generators.length).toBeGreaterThan(0);
    for (const g of generators) {
      expect(MANIFEST.rows.some((r) => r.generator.includes(`tools/${g}`)), `tools/${g} has no row in tools/generated-files.json`).toBe(true);
    }
  });

  it('each row names a tracked output and a generator, and every input matches a tracked file', () => {
    for (const r of MANIFEST.rows) {
      expect(tracked, `${r.output} is not a tracked file`).toContain(r.output);
      expect(r.generator.length, `${r.output}: generator`).toBeTruthy();
      expect(tracked, `${r.output}: script ${r.script} is not a tracked file`).toContain(r.script);
      expect(existsSync(join(ROOT, r.script)), `${r.output}: script ${r.script} does not exist`).toBe(true);
      for (const g of r.inputs) expect(tracked.some((f) => globRe(g).test(f)), `${r.output}: input ${g} matches no tracked file`).toBe(true);
    }
  });

  it("the instrument-scrub row covers every file the generator reads (the scrub, the catalogue's graph, esbuild and zod)", async () => {
    const row = MANIFEST.rows.find((r) => r.output === 'instrument-scrub.mjs')!;
    expect(row.generator).toBe(COMMAND);
    const read: string[] = [...(await generate()).inputs, ...(await realVocabulary()).catalogInputs];
    const local = read.filter((f) => !f.includes('node_modules/') && !f.includes(':') && !f.endsWith('-entry.js'));
    expect(local).toContain('packages/health-core/src/scrub-vocabulary.ts');
    for (const f of local) expect(row.inputs.some((g) => globRe(g).test(f)), `${f} is read by the generator but is not an input`).toBe(true);
    expect(row.inputs).toContain('package-lock.json');
  }, 60_000);
});

// ---- behaviour ----
const REFUSED = 9;
const GENERATOR = 'node gen.mjs';
const TEST_MANIFEST = JSON.stringify({ rows: [{ output: 'out.txt', script: 'gen.mjs', inputs: ['in.txt', 'src/*.txt', 'gen.mjs', 'blog/*.md'], generator: GENERATOR }] });
// Every binary the script may run, each a logging wrapper around the real one. Step 6 may add only git, jq and perl (the fetch's timeout).
const WRAPPED = ['git', 'jq', 'perl', 'sed', 'grep', 'paste', 'mktemp', 'rm', 'sh'];
let S: string;
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
const commit = (cwd: string, files: Record<string, string>, msg: string) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, f)), { recursive: true });
    writeFileSync(join(cwd, f), text);
  }
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD');
};
const real = (name: string) => execFileSync('/bin/sh', ['-c', 'command -v "$0"', name], { encoding: 'utf8', env: { PATH: process.env.PATH } }).trim();

beforeAll(() => {
  S = mkdtempSync(join(tmpdir(), 'merge-gated-gen-'));
  const bin = join(S, 'bin');
  mkdirSync(bin);
  for (const name of WRAPPED) {
    // One line per call: the name and its first argument (a jq or perl program spans lines).
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\t%s\\n' ${name} "$(printf '%s' "\${1:-}" | ${real('tr')} '\\n\\t' '  ')" >> "$CMDLOG"\nexec ${real(name)} "$@"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
printf 'gh\\t%s\\t%s\\n' "$1" "$2" >> "$CMDLOG"
jqf=; prev=
for a in "$@"; do [ "$prev" = --jq ] && jqf=$a; prev=$a; done
json() { printf '%s\\n' "$1" | ${real('jq')} -r "$jqf"; }
case "$*" in
  *"pr view"*state,headRefOid*) json "{\\"state\\":\\"OPEN\\",\\"headRefOid\\":\\"$HEAD_SHA\\"}" ;;
  *"pr view"*changedFiles*) json "$FILES" ;;
  *"pr view"*statusCheckRollup*) json '{"statusCheckRollup":[{"__typename":"CheckRun","name":"test","status":"COMPLETED","conclusion":"SUCCESS"}]}' ;;
  *"run list"*ci.yml*) json '[{"databaseId":1,"status":"completed","conclusion":"success","createdAt":"2026-11-13T00:00:00Z"}]' ;;
  *"run list"*deploy.yml*) json '[]' ;;
  *"pr merge"*) echo merged ;;
  *) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);
});
afterAll(() => rmSync(S, { recursive: true, force: true }));

/** A bare origin whose main holds the script, the test manifest and the inputs; a caller's clone; a work clone. */
function repos(withOutput = true, manifest = TEST_MANIFEST) {
  const d = mkdtempSync(join(S, 'case-'));
  const origin = join(d, 'origin.git');
  git(d, 'init', '-q', '--bare', origin);
  const work = join(d, 'work');
  git(d, 'clone', '-q', origin, work);
  mkdirSync(join(work, 'tools'));
  copyFileSync(join(TOOLS, 'merge-gated.sh'), join(work, 'tools', 'merge-gated.sh'));
  const generated = withOutput ? { 'out.txt': 'o\n', 'gen.mjs': 'g\n' } : {};
  commit(work, { 'tools/generated-files.json': manifest, 'in.txt': 'a\n', 'src/x.txt': 'x\n', 'src/y.txt': 'y\n', README: 'r\n', ...generated }, 'base');
  pushMain(work);
  const caller = join(d, 'caller');
  git(d, 'clone', '-q', origin, caller);
  const tmp = join(d, 'tmp');
  mkdirSync(tmp);
  return { d, work, caller, tmp };
}
const pushPr = (work: string, sha: string) => git(work, 'push', '-q', '-f', 'origin', `${sha}:refs/pull/123/head`);
function pushMain(work: string) { git(work, 'push', '-q', 'origin', 'HEAD:main'); }
/** On a pr branch from main's current tip: commit `files`, push as PR 123's head. */
function openPr(r: ReturnType<typeof repos>, files: Record<string, string>) {
  git(r.work, 'checkout', '-q', '-b', 'pr');
  const sha = commit(r.work, files, 'pr');
  pushPr(r.work, sha);
  git(r.work, 'checkout', '-q', 'main');
  return sha;
}
function moveMain(r: ReturnType<typeof repos>, files: Record<string, string>) {
  commit(r.work, files, 'main moves');
  pushMain(r.work);
}

function gate(r: ReturnType<typeof repos>, sha: string, files: string[], at: { cwd?: string; script?: string } = {}) {
  const log = join(r.d, `log-${Math.random()}`);
  const before = { refs: git(r.caller, 'for-each-ref', '--format=%(refname)', 'refs/heads'), head: git(r.caller, 'rev-parse', 'HEAD'), status: git(r.caller, 'status', '--porcelain') };
  const res = spawnSync('/bin/sh', [at.script ?? join(r.caller, 'tools', 'merge-gated.sh'), '123', sha], {
    cwd: at.cwd ?? r.caller, encoding: 'utf8',
    env: {
      HOME: process.env.HOME, ...GIT_ENV, PATH: join(S, 'bin'), CMDLOG: log, TMPDIR: r.tmp, HEAD_SHA: sha,
      FILES: JSON.stringify({ changedFiles: files.length, files: files.map((path) => ({ path })) }),
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t')) : [];
  return {
    status: res.status, stderr: res.stderr, calls, names: calls.map((c) => c[0]),
    gits: calls.filter((c) => c[0] === 'git').map((c) => c[1]),
    merges: calls.filter((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'merge'),
    untouched: git(r.caller, 'for-each-ref', '--format=%(refname)', 'refs/heads') === before.refs
      && git(r.caller, 'rev-parse', 'HEAD') === before.head && git(r.caller, 'status', '--porcelain') === before.status
      && readdirSync(r.tmp).length === 0,
  };
}

describe('US-64 AC34 merge-gated.sh refuses a PR whose generated file main has moved since its base (pure git)', () => {
  it("refuses PR 954's shape: the PR touches an input; main added the output and its generator script after the PR branched", () => {
    const r = repos(false);
    const sha = openPr(r, { 'in.txt': 'b\n' });
    moveMain(r, { 'out.txt': 'a\n', 'gen.mjs': 'g\n' });
    const g = gate(r, sha, ['in.txt']);
    expect(g.status).toBe(REFUSED);
    expect(g.stderr).toContain("out.txt: main has changed it or its generator script (gen.mjs) since this PR's base; merge main first, then let CI run");
    expect(g.stderr).toContain(GENERATOR);
    expect(g.merges).toEqual([]);
    expect(g.untouched).toBe(true);
  });

  it('refuses when the PR touches an input and main changed the output', () => {
    const r = repos();
    const sha = openPr(r, { 'src/x.txt': 'x2\n' });
    moveMain(r, { 'out.txt': 'o2\n' });
    const g = gate(r, sha, ['src/x.txt']);
    expect(g.status).toBe(REFUSED);
    expect(g.merges).toEqual([]);
  });

  it('refuses when the PR touches an input and main changed only the generator script', () => {
    const r = repos();
    const sha = openPr(r, { 'in.txt': 'b\n' });
    moveMain(r, { 'gen.mjs': 'g2\n' });
    const g = gate(r, sha, ['in.txt']);
    expect(g.status).toBe(REFUSED);
    expect(g.stderr).toContain('gen.mjs');
    expect(g.merges).toEqual([]);
  });

  it('passes when the PR touches one input and main changed only another input (not the output or the script)', () => {
    const r = repos();
    const sha = openPr(r, { 'in.txt': 'b\n' });
    moveMain(r, { 'src/y.txt': 'y2\n' });
    const g = gate(r, sha, ['in.txt']);
    // AC35: main moved one commit past the PR's base, so a staleness note (never a refusal).
    expect(g.stderr).toBe("merge-gated: note: main has moved 1 commit since this PR's merge base; CI may have tested an older main\n");
    expect(g.status).toBe(0);
    expect(g.merges).toHaveLength(1);
  });

  it("refuses a PR that renames an input away when main changed the output: the PR side reads git's paths, not gh's", () => {
    const r = repos();
    git(r.work, 'checkout', '-q', '-b', 'pr');
    git(r.work, 'mv', 'in.txt', 'other.txt');
    git(r.work, 'commit', '-q', '-m', 'rename');
    const sha = git(r.work, 'rev-parse', 'HEAD');
    pushPr(r.work, sha);
    git(r.work, 'checkout', '-q', 'main');
    moveMain(r, { 'out.txt': 'o2\n' });
    const g = gate(r, sha, ['other.txt']); // gh lists only the new path
    expect(g.status).toBe(REFUSED);
    expect(g.merges).toEqual([]);
  });

  it("sees main's newest commit even when the caller's clone fetches a narrow refspec", () => {
    const r = repos();
    git(r.caller, 'config', 'remote.origin.fetch', '+refs/heads/other:refs/remotes/origin/other');
    const sha = openPr(r, { 'in.txt': 'b\n' });
    moveMain(r, { 'out.txt': 'o2\n' });
    const g = gate(r, sha, ['in.txt']);
    expect(g.status).toBe(REFUSED);
    expect(g.merges).toEqual([]);
  });

  it('passes the same PR once main is merged into it, and merges it', () => {
    const r = repos();
    const first = openPr(r, { 'in.txt': 'b\n' });
    moveMain(r, { 'out.txt': 'o2\n' });
    git(r.work, 'checkout', '-q', 'pr');
    git(r.work, 'merge', '-q', '--no-edit', 'main');
    const sha = git(r.work, 'rev-parse', 'HEAD');
    expect(sha).not.toBe(first);
    pushPr(r.work, sha);
    const g = gate(r, sha, ['in.txt']);
    expect(g.stderr).toBe('');
    expect(g.status).toBe(0);
    expect(g.merges).toHaveLength(1);
    expect(g.untouched).toBe(true);
  });

  it('passes a PR touching an input when main moved only other files', () => {
    const r = repos();
    const sha = openPr(r, { 'in.txt': 'b\n' });
    moveMain(r, { README: 'r2\n' });
    const g = gate(r, sha, ['in.txt']);
    expect(g.status).toBe(0);
    expect(g.merges).toHaveLength(1);
  });

  it('never refuses a PR touching no row; it fetches and diffs (a rename hides from gh) but runs no git log', () => {
    const r = repos();
    const sha = openPr(r, { README: 'changed\n' });
    moveMain(r, { 'in.txt': 'c\n', 'out.txt': 'c\n' });
    const g = gate(r, sha, ['README']);
    expect(g.status).toBe(0);
    expect(g.merges).toHaveLength(1);
    expect(g.gits).toEqual(['fetch', 'cat-file', 'merge-base', 'rev-list', '-c']); // -c: `git -c core.quotepath=false diff`
    expect(g.untouched).toBe(true);
  });

  it('matches a non-ASCII path: the diff is not quoted (core.quotepath)', () => {
    const r = repos();
    const sha = openPr(r, { 'blog/café.md': 'c\n' });
    moveMain(r, { 'out.txt': 'o2\n' });
    const g = gate(r, sha, ['blog/café.md']);
    expect(g.status).toBe(REFUSED);
    expect(g.merges).toEqual([]);
  });

  it('a local branch named origin/main cannot shadow the fetched main', () => {
    const r = repos();
    git(r.caller, 'branch', 'origin/main'); // the caller's old main, before main moves
    const sha = openPr(r, { 'in.txt': 'b\n' });
    moveMain(r, { 'out.txt': 'o2\n' });
    const g = gate(r, sha, ['in.txt']);
    expect(g.status).toBe(REFUSED);
    expect(g.merges).toEqual([]);
  });

  it('refuses (4) a matched manifest row with no script, or an empty output, script or generator', () => {
    const row = { output: 'out.txt', script: 'gen.mjs', inputs: ['in.txt'], generator: GENERATOR };
    const noScript = { output: 'out.txt', inputs: ['in.txt'], generator: GENERATOR };
    for (const bad of [noScript, { ...row, script: '' }, { ...row, output: '' }, { ...row, generator: '' }]) {
      const r = repos(true, JSON.stringify({ rows: [bad] }));
      const sha = openPr(r, { 'in.txt': 'b\n' });
      const g = gate(r, sha, ['in.txt']);
      expect(g.status, JSON.stringify(bad)).toBe(4);
      expect(g.stderr).toContain('generated-files.json');
      expect(g.merges).toEqual([]);
    }
  });

  it("judges a PR that edits the manifest by main's rows (gate-file rule)", () => {
    const r = repos();
    const sha = openPr(r, { 'in.txt': 'b\n', 'tools/generated-files.json': '{"rows":[]}' });
    moveMain(r, { 'out.txt': 'o2\n' });
    // The caller runs the PR's copy: its manifest has no rows, so only main's copy can refuse.
    writeFileSync(join(r.caller, 'tools', 'generated-files.json'), '{"rows":[]}');
    const g = gate(r, sha, ['in.txt', 'tools/generated-files.json']);
    expect(g.stderr).toContain("main's copy judges it");
    expect(g.status).toBe(REFUSED);
    expect(g.stderr).toContain('out.txt: main has changed it or its generator script');
    expect(g.merges).toEqual([]);
  });

  it("T-13: a PR that renames the manifest away (gh lists only the new path) is judged by main's rows", () => {
    const r = repos();
    git(r.work, 'checkout', '-q', '-b', 'pr');
    writeFileSync(join(r.work, 'in.txt'), 'b\n');
    git(r.work, 'mv', 'tools/generated-files.json', 'tools/old manifest é.json');
    git(r.work, 'commit', '-q', '-am', 'rename the manifest');
    const sha = git(r.work, 'rev-parse', 'HEAD');
    pushPr(r.work, sha);
    git(r.work, 'checkout', '-q', 'main');
    moveMain(r, { 'out.txt': 'o2\n' });
    // The caller runs a copy whose manifest beside it has no rows, so only main's copy can refuse.
    writeFileSync(join(r.caller, 'tools', 'generated-files.json'), '{"rows":[]}');
    const g = gate(r, sha, ['in.txt', 'tools/old manifest é.json']);
    expect(g.stderr).toContain("main's copy judges it");
    expect(g.status).toBe(REFUSED);
    expect(g.merges).toEqual([]);
    expect(g.untouched).toBe(true);
  });

  it("T-13: a PR that renames tools/merge-gated.sh away is judged by main's copy (git's paths, not gh's)", () => {
    const r = repos();
    git(r.work, 'checkout', '-q', '-b', 'pr');
    git(r.work, 'mv', 'tools/merge-gated.sh', 'tools/merge gated (old).sh');
    git(r.work, 'commit', '-q', '-m', 'rename the gate');
    const sha = git(r.work, 'rev-parse', 'HEAD');
    pushPr(r.work, sha);
    git(r.work, 'checkout', '-q', 'main');
    const g = gate(r, sha, ['tools/merge gated (old).sh']);
    expect(g.stderr).toContain("main's copy judges it");
    expect(g.status).toBe(0);
    expect(g.merges).toHaveLength(1);
    expect(g.untouched).toBe(true);
  });

  it('runs nothing in step 6 but gh, git, jq and perl: no node, npx, sh -c or manifest command', () => {
    const r = repos();
    const sha = openPr(r, { 'in.txt': 'b\n' });
    const plain = gate(r, sha, ['README']); // a PR touching no row: step 6 fetches, diffs and matches, nothing more
    const hit = gate(r, sha, ['in.txt']);
    expect(hit.status).toBe(0);
    expect(hit.merges).toHaveLength(1);
    expect(new Set(hit.names)).toEqual(new Set(['gh', 'perl', 'git', 'jq', 'sed', 'grep']));
    const count = (names: string[]) => names.filter((n) => !['git', 'jq', 'perl'].includes(n)).sort();
    expect(count(hit.names)).toEqual(count(plain.names)); // a matched row adds only git and jq calls
    expect(hit.gits).toEqual(['fetch', 'cat-file', 'merge-base', 'rev-list', '-c', 'log']);
  });

  describe('T-12: finds generated-files.json beside the script from any working folder', () => {
    it('`sh merge-gated.sh` run inside tools/ reads tools/generated-files.json: refuses a stale row (9), merges a clean PR', () => {
      const r = repos();
      const stale = openPr(r, { 'in.txt': 'b\n' });
      moveMain(r, { 'out.txt': 'o2\n' });
      const here = { cwd: join(r.caller, 'tools'), script: 'merge-gated.sh' };
      const g = gate(r, stale, ['in.txt'], here);
      expect(g.stderr).toContain('out.txt: main has changed it or its generator script');
      expect(g.status).toBe(REFUSED);
      expect(g.merges).toEqual([]);
      const c = repos();
      const tidy = openPr(c, { README: 'changed\n' });
      moveMain(c, { 'out.txt': 'o2\n' });
      const clean = gate(c, tidy, ['README'], { cwd: join(c.caller, 'tools'), script: 'merge-gated.sh' });
      expect(clean.status).toBe(0);
      expect(clean.merges).toHaveLength(1);
    });

    it('a copy run by absolute path from another folder reads the manifest beside the copy, not the one in the working folder', () => {
      const r = repos();
      const sha = openPr(r, { 'in.txt': 'b\n' });
      moveMain(r, { 'out.txt': 'o2\n' });
      const copy = join(r.d, 'elsewhere');
      mkdirSync(copy);
      copyFileSync(join(TOOLS, 'merge-gated.sh'), join(copy, 'merge-gated.sh'));
      // Beside the copy: no rows, so it merges. The caller's tools/generated-files.json would refuse.
      writeFileSync(join(copy, 'generated-files.json'), '{"rows":[]}');
      const g = gate(r, sha, ['in.txt'], { cwd: r.caller, script: join(copy, 'merge-gated.sh') });
      expect(g.status).toBe(0);
      expect(g.merges).toHaveLength(1);
      // And with the test manifest beside it, the same copy refuses.
      writeFileSync(join(copy, 'generated-files.json'), TEST_MANIFEST);
      expect(gate(r, sha, ['in.txt'], { cwd: r.caller, script: join(copy, 'merge-gated.sh') }).status).toBe(REFUSED);
    });
  });
});
