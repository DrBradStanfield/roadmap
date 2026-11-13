/**
 * US-64 AC34: merge-gated.sh checks every generated file whose inputs a PR touches, against the merge of the PR
 * head into CURRENT main, before it merges. Why: PR 954 changed scrub-vocabulary.ts and ran green against a main
 * that did not yet have the instrument-scrub generator; after the merge main went red with a stale output.
 *
 * The pins read the real manifest, tools/generated-files.json. The behaviour tests run a byte copy of the script
 * beside a test manifest, in throwaway git repos (a bare origin, a caller's clone), with a stub `gh` that answers
 * from fixture JSON through the script's own --jq filters and logs every call.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain .mjs tool with no declarations.
import { COMMAND, generate, realVocabulary } from './generate-instrument-scrub.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(TOOLS, '..');
type Row = { output: string; inputs: string[]; check: string; generator: string };
const MANIFEST: { rows: Row[] } = JSON.parse(readFileSync(join(TOOLS, 'generated-files.json'), 'utf8'));
// The script matches with sh `case`, where * also matches a slash.
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

  it('each row names a tracked output, a check and a generator, and every input matches a tracked file', () => {
    for (const r of MANIFEST.rows) {
      expect(tracked, `${r.output} is not a tracked file`).toContain(r.output);
      expect(r.check.length && r.generator.length, `${r.output}: check and generator`).toBeTruthy();
      for (const g of r.inputs) expect(tracked.some((f) => globRe(g).test(f)), `${r.output}: input ${g} matches no tracked file`).toBe(true);
    }
  });

  it("the instrument-scrub row covers every file the generator reads (the scrub, the catalogue's graph, esbuild and zod)", async () => {
    const row = MANIFEST.rows.find((r) => r.output === 'instrument-scrub.mjs')!;
    expect(row.check).toBe(`${COMMAND} --check`);
    expect(row.generator).toBe(COMMAND);
    const read: string[] = [...(await generate()).inputs, ...(await realVocabulary()).catalogInputs];
    const local = read.filter((f) => !f.includes('node_modules/') && !f.includes(':') && !f.endsWith('-entry.js'));
    expect(local).toContain('packages/health-core/src/scrub-vocabulary.ts');
    for (const f of local) expect(row.inputs.some((g) => globRe(g).test(f)), `${f} is read by the generator but is not an input`).toBe(true);
    expect(row.inputs).toContain('package-lock.json');
  }, 60_000);
});

// ---- behaviour ----
const SHA_RE = /^[0-9a-f]{40}$/;
const REFUSED = 9; // merge-gated's "not green" refusal: a check on what would land is red.
let S: string;
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
const commit = (cwd: string, files: Record<string, string>, msg: string) => {
  for (const [f, text] of Object.entries(files)) writeFileSync(join(cwd, f), text);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', msg);
  return git(cwd, 'rev-parse', 'HEAD');
};

beforeAll(() => {
  S = mkdtempSync(join(tmpdir(), 'merge-gated-gen-'));
  mkdirSync(join(S, 'bin'));
  writeFileSync(join(S, 'bin', 'gh'), `#!/bin/sh
printf '%s\\t' "$@" >> "$LOG"; echo >> "$LOG"
jqf=; prev=
for a in "$@"; do [ "$prev" = --jq ] && jqf=$a; prev=$a; done
json() { printf '%s\\n' "$1" | jq -r "$jqf"; }
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
  chmodSync(join(S, 'bin', 'gh'), 0o755);
  // The script under test, byte for byte, beside a test manifest: out.txt is in.txt, copied.
  mkdirSync(join(S, 'tools'));
  copyFileSync(join(TOOLS, 'merge-gated.sh'), join(S, 'tools', 'merge-gated.sh'));
  writeFileSync(join(S, 'tools', 'generated-files.json'), JSON.stringify({
    rows: [{ output: 'out.txt', inputs: ['in.txt'], check: 'cmp -s in.txt out.txt', generator: 'cp in.txt out.txt' }],
  }));
});
afterAll(() => rmSync(S, { recursive: true, force: true }));

/** A bare origin whose main holds `base`, a caller's clone of it, and a work clone to build commits in. */
function repos() {
  const d = mkdtempSync(join(S, 'case-'));
  const origin = join(d, 'origin.git');
  git(d, 'init', '-q', '--bare', origin);
  const work = join(d, 'work');
  git(d, 'clone', '-q', origin, work);
  commit(work, { 'in.txt': 'a\n', 'README': 'r\n' }, 'base');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  const caller = join(d, 'caller');
  git(d, 'clone', '-q', origin, caller);
  const tmp = join(d, 'tmp');
  mkdirSync(tmp);
  return { d, origin, work, caller, tmp };
}
const pushPr = (work: string, sha: string) => git(work, 'push', '-q', '-f', 'origin', `${sha}:refs/pull/123/head`);
const pushMain = (work: string) => git(work, 'push', '-q', 'origin', 'HEAD:main');

function gate(r: ReturnType<typeof repos>, sha: string, files: string[]) {
  const log = join(r.d, `log-${Math.random()}`);
  const before = { refs: git(r.caller, 'for-each-ref', '--format=%(refname)', 'refs/heads'), head: git(r.caller, 'rev-parse', 'HEAD') };
  const res = spawnSync('sh', [join(S, 'tools', 'merge-gated.sh'), '123', sha], {
    cwd: r.caller, encoding: 'utf8',
    env: {
      ...process.env, ...GIT_ENV, PATH: `${join(S, 'bin')}:${process.env.PATH}`, LOG: log, TMPDIR: r.tmp, HEAD_SHA: sha,
      FILES: JSON.stringify({ changedFiles: files.length, files: files.map((path) => ({ path })) }),
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return {
    ...res, merges: calls.filter((c) => c.startsWith('pr\tmerge')),
    worktrees: git(r.caller, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')),
    refsSame: git(r.caller, 'for-each-ref', '--format=%(refname)', 'refs/heads') === before.refs,
    headSame: git(r.caller, 'rev-parse', 'HEAD') === before.head,
    status: res.status, clean: git(r.caller, 'status', '--porcelain') === '', tmpLeft: readdirSync(r.tmp),
  };
}
const leftNothing = (g: ReturnType<typeof gate>) => {
  expect(g.worktrees).toHaveLength(1);
  expect(g.refsSame && g.headSame && g.clean).toBe(true);
  expect(g.tmpLeft).toEqual([]);
};

describe('US-64 AC34 merge-gated.sh checks generated files against the merge into current main', () => {
  it("refuses PR 954's case: a PR touching an input, fresh on its base, leaves the output stale once merged into current main", () => {
    const r = repos();
    git(r.work, 'checkout', '-q', '-b', 'pr');
    const sha = commit(r.work, { 'in.txt': 'b\n' }, 'pr: change the input');
    pushPr(r.work, sha);
    git(r.work, 'checkout', '-q', 'main');
    commit(r.work, { 'out.txt': 'a\n' }, 'main: add the generated output'); // main gains the generator after the PR's CI
    pushMain(r.work);
    const g = gate(r, sha, ['in.txt']);
    expect(SHA_RE.test(sha)).toBe(true);
    expect(g.status).toBe(REFUSED);
    expect(g.stderr).toMatch(/out\.txt/);
    expect(g.stderr).toContain('cp in.txt out.txt');
    expect(g.merges).toEqual([]);
    leftNothing(g);
  });

  it('passes a PR that regenerated its output, and merges it', () => {
    const r = repos();
    commit(r.work, { 'out.txt': 'a\n' }, 'main: add the generated output');
    pushMain(r.work);
    git(r.work, 'checkout', '-q', '-b', 'pr');
    const sha = commit(r.work, { 'in.txt': 'b\n', 'out.txt': 'b\n' }, 'pr: input and output');
    pushPr(r.work, sha);
    const g = gate(r, sha, ['in.txt', 'out.txt']);
    expect(g.stderr).toBe('');
    expect(g.status).toBe(0);
    expect(g.merges).toHaveLength(1);
    leftNothing(g);
  });

  it('refuses with "merge main first" when the PR does not merge cleanly into current main', () => {
    const r = repos();
    commit(r.work, { 'out.txt': 'a\n' }, 'main: add the generated output');
    pushMain(r.work);
    git(r.work, 'checkout', '-q', '-b', 'pr');
    const sha = commit(r.work, { 'in.txt': 'b\n', 'out.txt': 'b\n' }, 'pr');
    pushPr(r.work, sha);
    git(r.work, 'checkout', '-q', 'main');
    commit(r.work, { 'in.txt': 'c\n', 'out.txt': 'c\n' }, 'main moves the same lines');
    pushMain(r.work);
    const g = gate(r, sha, ['in.txt', 'out.txt']);
    expect(g.status).toBe(REFUSED);
    expect(g.stderr).toMatch(/merge main first/);
    expect(g.merges).toEqual([]);
    leftNothing(g);
  });

  it('does not build a temp tree for a PR that touches no listed input', () => {
    const r = repos();
    git(r.work, 'checkout', '-q', '-b', 'pr');
    const sha = commit(r.work, { README: 'changed\n' }, 'pr');
    pushPr(r.work, sha);
    const g = gate(r, sha, ['README']);
    expect(g.status).toBe(0);
    expect(g.merges).toHaveLength(1);
    expect(existsSync(join(r.caller, '.git', 'FETCH_HEAD'))).toBe(false); // no fetch ran
    leftNothing(g);
  });
});
