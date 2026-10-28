// US-25 AC18: the CI engine release (.github/workflows/engine-release.yml, ios/engine-updates.md).
// Holds the workflow's guards in place, runs the sign job's check and commit steps on
// temp fixtures, and runs its signing commands with a throwaway key to prove the app's
// verifier (engine-signing.mjs, as sign-engine.mjs uses it) accepts what CI signs.
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { bridgeId } from './build-engine.mjs';
import { canonicalManifest, publicKeyOf, verifyManifest } from './engine-signing.mjs';

type Step = { name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = { if?: string; needs?: string | string[]; permissions?: Record<string, string>; environment?: string; steps: Step[]; env?: Record<string, string>; outputs?: Record<string, string> };
type Workflow = { on: any; permissions: unknown; concurrency: unknown; jobs: Record<string, Job> };

const repo = join(__dirname, '..', '..');
const wf = yaml.load(readFileSync(join(repo, '.github/workflows/engine-release.yml'), 'utf8')) as Workflow;
const runs = (job: string) => wf.jobs[job].steps.map((s) => s.run ?? '').join('\n');
const step = (job: string, name: string) => wf.jobs[job].steps.find((s) => s.name?.startsWith(name))!.run!;
const work = mkdtempSync(join(tmpdir(), 'engine-wf-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

// GNU tools the runner has, shimmed on macOS; a git stub that only logs.
const shims = join(work, 'shims');
mkdirSync(shims, { recursive: true });
const shim = (dir: string, name: string, body: string) => { writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`); chmodSync(join(dir, name), 0o755); };
if (process.platform === 'darwin') {
  shim(shims, 'stat', '[ "$1" = -c ] && [ "$2" = %s ] && shift 2 && exec /usr/bin/stat -f %z "$@"; exec /usr/bin/stat "$@"');
  shim(shims, 'base64', 'if [ "$1" = -w0 ]; then shift; if [ -n "$1" ]; then /usr/bin/base64 -i "$1"; else /usr/bin/base64; fi | tr -d "\\n"; exit; fi; exec /usr/bin/base64 "$@"');
  shim(shims, 'shred', '[ "$1" = -u ] && shift; exec /bin/rm -P "$@"');
  shim(shims, 'sha256sum', 'exec /usr/bin/shasum -a 256 "$@"');
}
const gitStub = join(work, 'git-stub');
mkdirSync(gitStub, { recursive: true });
shim(gitStub, 'git', 'echo "$*" >> "$GIT_LOG"');

const bash = (script: string, cwd: string, env: Record<string, string | undefined>, path = shims) =>
  spawnSync('bash', ['-eo', 'pipefail', '-c', script], { cwd, env: { ...process.env, ...env, PATH: `${path}:${process.env.PATH}` }, encoding: 'utf8' });

const BRIDGE = '0123456789abcdef';
const BUILT_SHA = 'a'.repeat(40);
/** A built artifact in `dir/built`, and optionally a release already on main for BRIDGE. */
function fixture(name: string, opts: { version?: number; minVersion?: number; main?: Record<string, unknown> } = {}) {
  const dir = join(work, name);
  mkdirSync(join(dir, 'built'), { recursive: true });
  const bundle = Buffer.from(`// engine ${name}\n`);
  const sha = createHash('sha256').update(bundle).digest('hex');
  writeFileSync(join(dir, 'built', `${sha}.js`), bundle);
  writeFileSync(join(dir, 'built/manifest.json'), canonicalManifest({ bridge: BRIDGE, keyId: 'ci', minVersion: opts.minVersion ?? 0, sha256: sha, size: bundle.length, version: opts.version ?? 202610250900 }));
  if (opts.main) {
    mkdirSync(join(dir, `ios/engine-release/bridge-${BRIDGE}`), { recursive: true });
    writeFileSync(join(dir, `ios/engine-release/bridge-${BRIDGE}/manifest.json`), JSON.stringify(opts.main));
  }
  return { dir, env: { BRIDGE, BUILT_SHA, BUNDLE: sha, GIT_LOG: join(dir, 'git.log') } };
}

describe('engine-release workflow (US-25 AC18)', () => {
  it('starts only after a Deploy dispatched on main in this repo, or by hand', () => {
    expect(wf.on.workflow_run).toEqual({ workflows: ['Deploy'], types: ['completed'], branches: ['main'] });
    expect(wf.on.workflow_dispatch.inputs.reissue).toMatchObject({ type: 'boolean', default: false });
    const cond = wf.jobs.build.if!;
    expect(cond).toContain("github.event_name == 'workflow_dispatch'");
    expect(cond).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(cond).toContain("github.event.workflow_run.event == 'workflow_dispatch'");
    expect(cond).toContain('github.event.workflow_run.head_repository.full_name == github.repository');
    expect(wf.concurrency).toBe('engine-release');
    // A re-issue runs verify even when build said unchanged (it then fails with no artifact).
    expect(wf.jobs.verify.if).toBe("needs.build.outputs.changed == 'true' || (github.event_name == 'workflow_dispatch' && inputs.reissue)");
  });

  it('grants nothing by default; only sign may write, behind engine-signing', () => {
    expect(wf.permissions).toEqual({});
    expect(wf.jobs.build.permissions).toEqual({ contents: 'read' });
    expect(wf.jobs.verify.permissions).toEqual({ contents: 'read' });
    expect(wf.jobs.sign.permissions).toEqual({ contents: 'write' });
    expect(wf.jobs.sign.environment).toBe('engine-signing');
    expect(wf.jobs.sign.needs).toBe('verify');
    expect(wf.jobs.sign.if).toBeUndefined();
    for (const job of ['build', 'verify']) expect(JSON.stringify(wf.jobs[job])).not.toContain('secrets.');
  });

  it('pins every action to a full commit SHA', () => {
    const uses = Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.uses).filter(Boolean)) as string[];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  it('puts no expression inside a run block (values arrive through env)', () => {
    for (const job of Object.values(wf.jobs)) for (const s of job.steps) expect(s.run ?? '').not.toContain('${{');
  });

  it('build decides only whether to upload; verify takes the commit and bridge itself', () => {
    expect(Object.keys(wf.jobs.build.outputs!)).toEqual(['changed']);
    expect(wf.jobs.verify.env!.SHA).toBe('${{ github.event.workflow_run.head_sha || github.sha }}');
    expect(JSON.stringify(wf.jobs.verify.steps)).not.toContain('needs.build');
    expect(JSON.stringify(wf.jobs.sign)).not.toContain('needs.build');
    const v = runs('verify');
    expect(v).toContain('bridge=$(sha256sum ios/engine/bridge-contract.json | cut -c1-16)');
    expect(v).toContain('test "$(jq -r .bridge built/manifest.json)" = "$bridge"');
    expect(v).toContain('git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main');
    expect(v).toContain('git diff --quiet "$SHA" origin/main --');
  });

  it('both main-moved checks cover every engine input', () => {
    const inputs = 'packages/health-core ios/engine ios/scripts ios/HealthRoadmap.xcodeproj/project.pbxproj package.json package-lock.json \':(glob)**/.npmrc\' \':(glob)**/tsconfig*\'';
    expect(runs('verify')).toContain(`git diff --quiet "$SHA" origin/main -- ${inputs}`);
    expect(step('sign', 'Main has not moved')).toContain(`git diff --quiet "$BUILT_SHA" HEAD -- ${inputs}`);
    for (const job of ['verify', 'sign']) expect(runs(job)).toContain('main moved since this Deploy; dispatch Engine release again');
  });

  it('the summary diffs from the commit the last release was built from, unfiltered and size-capped', () => {
    const s = step('verify', 'What will be signed');
    expect(s).toContain('git show "origin/main:ios/engine-release/bridge-$bridge/built-from"');
    expect(s).toContain('so it is approximate');
    expect(s).toContain('git diff --stat "$base" "$SHA"');
    expect(s).toContain('git log --stat "$base".."$SHA"');
    expect(s).toContain('ios/HealthRoadmap\\.xcodeproj/project\\.pbxproj$');
    expect(s).toContain('(.*/)?\\.npmrc$');
    expect(s).toContain('-gt 1000000');
    expect(s).toMatch(/SUMMARY TRUNCATED[^\n]*\n\s*exit 1/);
    expect(step('sign', 'Commit the release')).toContain('printf \'%s\\n\' "$BUILT_SHA" > "$dest/built-from"');
  });

  it('every regex guard fails closed whatever the shell (bash 3.2 ignores set -e on [[ ]])', () => {
    for (const job of ['verify', 'sign']) for (const line of runs(job).split('\n')) if (/^\s*\[\[/.test(line)) expect(line).toMatch(/\]\] \|\| exit 1$/);
  });

  describe('the sign check step, on fixtures', () => {
    const check = step('sign', 'Check the artifact again');
    it('passes a clean artifact', () => {
      const f = fixture('check-clean', { minVersion: 5, main: { minVersion: 5, version: 202610250800 } });
      expect(bash(check, f.dir, f.env).status).toBe(0);
    });
    it('refuses an extra file in the artifact', () => {
      const f = fixture('check-extra');
      writeFileSync(join(f.dir, 'built/built-from'), BUILT_SHA);
      expect(bash(check, f.dir, f.env).status).not.toBe(0);
    });
    it('refuses a floor below main\'s', () => {
      const f = fixture('check-floor', { minVersion: 4, main: { minVersion: 5, version: 202610250800 } });
      const run = bash(check, f.dir, f.env);
      expect(run.status).not.toBe(0);
      expect(run.stdout).toContain('the floor only rises');
    });
    it('refuses a malformed bundle hash', () => {
      const f = fixture('check-shape');
      expect(bash(check, f.dir, { ...f.env, BUNDLE: 'abc' }).status).not.toBe(0);
    });
  });

  describe('the commit step, on fixtures, with git stubbed', () => {
    const commit = step('sign', 'Commit the release');
    const prep = (name: string, opts: Parameters<typeof fixture>[1]) => {
      const f = fixture(name, opts);
      writeFileSync(join(f.dir, 'built/manifest.sig'), 'sig\n');
      return { ...f, run: bash(commit, f.dir, f.env, `${gitStub}:${shims}`) };
    };
    const gitLog = (dir: string) => (existsSync(join(dir, 'git.log')) ? readFileSync(join(dir, 'git.log'), 'utf8') : '');
    it('commits a newer release with its built-from record', () => {
      const { dir, run } = prep('commit-clean', { version: 202610250900, main: { minVersion: 0, version: 202610250800 } });
      expect(run.status).toBe(0);
      expect(gitLog(dir)).toContain('push origin HEAD:main');
      expect(readFileSync(join(dir, `ios/engine-release/bridge-${BRIDGE}/built-from`), 'utf8')).toBe(`${BUILT_SHA}\n`);
    });
    it('commits nothing over a newer release on main', () => {
      const { dir, run } = prep('commit-older', { version: 202610250900, main: { minVersion: 0, version: 202610251000 } });
      expect(run.status).toBe(0);
      expect(run.stdout).toContain('nothing to commit');
      expect(gitLog(dir)).toBe('');
    });
    it('fails on a malformed version on main', () => {
      const { dir, run } = prep('commit-have', { version: 202610250900, main: { version: '2026-10-25' } });
      expect(run.status).not.toBe(0);
      expect(gitLog(dir)).toBe('');
    });
  });

  // The sign step's own commands, with a throwaway key: what CI signs, the app accepts.
  const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' });
  const major = /^OpenSSL (\d+)\./.exec(openssl.stdout ?? '')?.[1];
  const hasOpenssl3 = openssl.status === 0 && Number(major) >= 3;
  if (!hasOpenssl3) console.warn(`skipping the CI signing run: needs OpenSSL 3 or later on PATH (found: ${openssl.stdout?.trim() || 'none'})`);

  it.skipIf(!hasOpenssl3)('the sign step makes a signature sign-engine.mjs accepts', () => {
    const signStep = wf.jobs.sign.steps.find((s) => s.env?.ENGINE_SIGNING_KEY)!.run!;
    const seed = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
    const pin = publicKeyOf(seed).toString('base64');
    const dir = join(work, 'run');
    mkdirSync(join(dir, 'built'), { recursive: true });
    mkdirSync(join(dir, 'ios/engine'), { recursive: true });
    writeFileSync(join(dir, 'ios/engine/signing-keys.json'), JSON.stringify({ ci: pin }));
    const bundle = Buffer.from('// engine\n');
    const sha = createHash('sha256').update(bundle).digest('hex');
    const manifest = canonicalManifest({ bridge: bridgeId(), keyId: 'ci', sha256: sha, size: bundle.length, version: 202610250900 });
    writeFileSync(join(dir, 'built/manifest.json'), manifest);
    writeFileSync(join(dir, `built/${sha}.js`), bundle);

    const run = bash(signStep, dir, { ENGINE_SIGNING_KEY: seed.toString('base64') });
    expect(run.stderr).not.toMatch(/error/i);
    expect(run.status).toBe(0);

    const sig = readFileSync(join(dir, 'built/manifest.sig'), 'utf8');
    expect(sig.endsWith('\n')).toBe(true);
    expect(verifyManifest(manifest, Buffer.from(sig.trim(), 'base64'), publicKeyOf(seed))).toBe(true);

    // sign-engine.mjs itself, with no key at all: it verifies the CI signature against the
    // pin and stops ("already signed"); a bad signature would make it ask for a key and fail.
    const out = join(work, 'out');
    mkdirSync(join(out, `bridge-${bridgeId()}`), { recursive: true });
    for (const f of ['manifest.json', 'manifest.sig', `${sha}.js`]) writeFileSync(join(out, `bridge-${bridgeId()}`, f), readFileSync(join(dir, 'built', f)));
    const noKey: Record<string, string | undefined> = { ...process.env };
    delete noKey.ENGINE_SIGNING_KEY;
    const signer = spawnSync(process.execPath, [join(__dirname, 'sign-engine.mjs'), '--key', 'ci', '--out', out, '--keys', join(dir, 'ios/engine/signing-keys.json')], { env: noKey, encoding: 'utf8' });
    expect(signer.stdout).toContain('is already signed: nothing to do');
    expect(signer.status).toBe(0);

    // A secret that is not the pinned key signs nothing.
    rmSync(join(dir, 'built/manifest.sig'));
    const other = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
    expect(bash(signStep, dir, { ENGINE_SIGNING_KEY: other.toString('base64') }).status).not.toBe(0);
  });
});
