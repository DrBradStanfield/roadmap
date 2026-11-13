// US-25 AC18: the over-the-air engine release (ios/architecture.md D3).
// Runs the real release script against a throwaway key and a temp folder.
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { bridgeId } from './build-engine.mjs';
import { canonicalManifest, DOMAIN, publicKeyOf, signManifest, verifyManifest } from './engine-signing.mjs';

const script = join(__dirname, 'release-engine.mjs');
const signer = join(__dirname, 'sign-engine.mjs');
const work = mkdtempSync(join(tmpdir(), 'release-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function newSeed(): Buffer {
  return generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
}
const seed = newSeed();
const pinsFile = join(work, 'pins.json');
writeFileSync(pinsFile, JSON.stringify({ daily: publicKeyOf(seed).toString('base64') }));
const out = join(work, 'out');
const dir = join(out, `bridge-${bridgeId()}`);
/** A floor of 1, so these tests choose any build; the committed floor has its own test below. */
const floorFile = join(work, 'floor.json');
writeFileSync(floorFile, JSON.stringify({ minAppBuild: 1 }));

/** Step 1, the build, as `env -u ENGINE_SIGNING_KEY node …` runs it: no key. */
function build(now: string, extra: string[] = [], env: Record<string, string> = {}) {
  const clean: Record<string, string | undefined> = { ...process.env, ...env };
  delete clean.ENGINE_SIGNING_KEY;
  return spawnSync(process.execPath, [script, '--out', out, '--keys', pinsFile, '--floor', floorFile, '--allow-dirty', '--now', now, ...extra], {
    env: clean,
    encoding: 'utf8',
  });
}

/** The build, with every child process it starts logged (fixtures/spawn-probe.mjs).
 *  A refusal must start no process at all, so it costs no build (TA-C01, PR 1527 review R2). */
function probedBuild(now: string, extra: string[] = []) {
  const log = join(work, `spawns-${now.replace(/:/g, '')}.log`);
  writeFileSync(log, '');
  const probe = pathToFileURL(join(__dirname, 'fixtures/spawn-probe.mjs')).href;
  const run = build(now, extra, { NODE_OPTIONS: `--import ${probe}`, SPAWN_PROBE_LOG: log });
  const spawned = readFileSync(log, 'utf8');
  return { run, spawned };
}

/** Step 2, the signer, with `key` as ENGINE_SIGNING_KEY. */
function sign(key = seed, extra: string[] = []) {
  return spawnSync(process.execPath, [signer, '--out', out, '--keys', pinsFile, ...extra], {
    env: { ...process.env, ENGINE_SIGNING_KEY: key.toString('base64') },
    encoding: 'utf8',
  });
}

/** Both steps, as Brad runs them: the build, then the signer directly. */
function release(now: string, extra: string[] = []) {
  const built = build(now, extra);
  return built.status === 0 ? sign() : built;
}

const manifestBytes = () => readFileSync(join(dir, 'manifest.json'));
const manifest = () => JSON.parse(manifestBytes().toString());

describe('release-engine (US-25 AC18)', () => {
  it('refuses a key id the app does not pin, before building', () => {
    const run = build('2026-10-22T03:15:00Z', ['--key', 'nobody']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('No pinned public key named nobody');
    expect(existsSync(dir)).toBe(false);
  });

  /** Logs every module the build resolves, and whether the key was in the environment then. */
  function moduleProbe(): { options: Record<string, string>; log: string } {
    const log = join(work, `modules-${Date.now()}.log`);
    const hooks = join(work, 'module-hooks.mjs');
    const register = join(work, 'module-register.mjs');
    writeFileSync(hooks, `import { appendFileSync } from 'node:fs';
export async function resolve(specifier, context, next) {
  const answer = await next(specifier, context);
  appendFileSync(process.env.MODULE_PROBE_LOG, answer.url + ' ' + (process.env.ENGINE_SIGNING_KEY ? 'KEY' : 'none') + '\\n');
  return answer;
}
`);
    writeFileSync(register, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
    writeFileSync(log, '');
    return { options: { NODE_OPTIONS: `--import ${pathToFileURL(register).href}`, MODULE_PROBE_LOG: log }, log };
  }

  it('refuses to start with a signing key in its environment, before importing any build code (review N3)', () => {
    const probe = moduleProbe();
    const run = spawnSync(process.execPath, [script, '--out', out, '--keys', pinsFile, '--allow-dirty', '--now', '2026-10-22T02:00:00Z'], {
      env: { ...process.env, ENGINE_SIGNING_KEY: seed.toString('base64'), ...probe.options },
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('ENGINE_SIGNING_KEY');
    const loaded = readFileSync(probe.log, 'utf8');
    expect(loaded).not.toContain('build-engine.mjs'); // no build module ever saw the key
    expect(existsSync(dir)).toBe(false);
  });

  it('without the key, the modules the build imports run and see none', () => {
    const probe = moduleProbe();
    const run = build('2026-10-22T02:30:00Z', [], probe.options);
    expect(run.status, run.stderr).toBe(0);
    const builds = readFileSync(probe.log, 'utf8').split('\n').filter((line) => line.includes('build-engine.mjs'));
    expect(builds.length).toBeGreaterThan(0);
    expect(builds.filter((line) => line.endsWith(' KEY'))).toEqual([]);
    rmSync(out, { recursive: true, force: true });
  }, 120_000);

  it('the signer refuses a key the app does not pin', () => {
    const built = build('2026-10-22T03:00:00Z');
    expect(built.status, built.stderr).toBe(0);
    const run = sign(newSeed());
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('not the pinned daily key');
    expect(existsSync(join(dir, 'manifest.sig'))).toBe(false);
    rmSync(out, { recursive: true, force: true });
  }, 120_000);

  it('the signer imports only Node and engine-signing.mjs', () => {
    const source = readFileSync(signer, 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.filter((name) => !name.startsWith('node:'))).toEqual(['./engine-signing.mjs']);
  });

  it('writes a canonical, signed manifest for a content-addressed bundle', () => {
    const run = release('2026-10-22T03:15:42Z', ['--min-app-build', '3']);
    expect(run.status, run.stderr).toBe(0);
    const bytes = manifestBytes();
    const m = manifest();
    expect(Object.keys(m)).toEqual(['appId', 'bridge', 'channel', 'format', 'issuedAt', 'keyId', 'minAppBuild', 'minVersion', 'notAfter', 'schemaVersion', 'sha256', 'size', 'version']);
    expect(bytes.equals(canonicalManifest(m))).toBe(true);
    expect(m).toMatchObject({
      appId: 'com.drstanfield.healthroadmap', bridge: bridgeId(), channel: 'production', format: 1,
      issuedAt: '2026-10-22T03:15:00Z', notAfter: '2026-11-21T03:15:00Z', keyId: 'daily',
      minAppBuild: 3, minVersion: 0, schemaVersion: 3, version: 202610220315,
    });
    const bundle = readFileSync(join(dir, `${m.sha256}.js`));
    expect(createHash('sha256').update(bundle).digest('hex')).toBe(m.sha256);
    expect(bundle.length).toBe(m.size);
    expect(bundle.toString()).toContain('202610220315');

    const sig = Buffer.from(readFileSync(join(dir, 'manifest.sig'), 'utf8').trim(), 'base64');
    expect(verifyManifest(bytes, sig, publicKeyOf(seed))).toBe(true);
    expect(verifyManifest(bytes, sig, publicKeyOf(newSeed()))).toBe(false);
    // The domain prefix is part of what is signed: a bare signature over the bytes is not this one.
    expect(signManifest(bytes, seed).equals(sig)).toBe(true);
    expect(DOMAIN).toBe('health-roadmap-engine-manifest/v1\n');
  }, 120_000);

  it('refuses a second release in the same minute: versions only rise', () => {
    const before = manifestBytes();
    const run = build('2026-10-22T03:15:59Z');
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('one release a minute');
    expect(manifestBytes().equals(before)).toBe(true);
  });

  it('--if-changed releases nothing for an unchanged engine', () => {
    const before = manifestBytes();
    const run = build('2026-10-22T04:00:00Z', ['--if-changed']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('nothing to release');
    expect(sign().stdout).toContain('already signed');
    expect(manifestBytes().equals(before)).toBe(true);
  }, 120_000);

  it('a later release rises, keeps the floor and the build, and keeps only the previous bundle', () => {
    const first = manifest();
    writeFileSync(join(dir, 'stale.js'), 'old');
    const run = build('2026-10-22T05:00:00Z');
    expect(run.status, run.stderr).toBe(0);
    const next = manifest();
    expect(next.version).toBe(202610220500);
    expect(next.version).toBeGreaterThan(first.version);
    expect(next.minAppBuild).toBe(3);
    expect(readdirSync(dir).sort()).toEqual([`${first.sha256}.js`, `${next.sha256}.js`, 'manifest.json'].sort());
    expect(existsSync(join(dir, 'manifest.sig'))).toBe(false); // the build never signs; the old signature is gone
  }, 120_000);

  it('refuses to lower the floor, before building', () => {
    const raise = probedBuild('2026-10-22T06:00:00Z', ['--min-version', '202610220500']);
    expect(raise.run.status, raise.run.stderr).toBe(0);
    expect(raise.spawned).toContain('esbuild'); // the probe sees a real build
    const lower = probedBuild('2026-10-22T07:00:00Z', ['--min-version', '1']);
    expect(lower.run.status).not.toBe(0);
    expect(lower.run.stderr).toContain('The floor only rises');
    expect(lower.spawned).toBe('');
  }, 120_000);

  // PR 1218 (US-72 AC10): an engine without the erasedAt checks must never reach a build
  // without the Apple Health disconnect. The committed floor is 11 (build 10 is the highest uploaded).
  it('refuses a manifest whose minAppBuild is below the committed floor, and keeps the last one', () => {
    const committed = join(__dirname, '..', 'engine-floor.json');
    expect(JSON.parse(readFileSync(committed, 'utf8')).minAppBuild).toBe(11);
    const before = manifestBytes();
    expect(manifest().minAppBuild).toBe(3);
    const carried = probedBuild('2026-10-22T08:00:00Z', ['--floor', committed]);
    expect(carried.run.status).not.toBe(0);
    expect(carried.run.stderr).toContain('--min-app-build 3 is below the floor 11');
    expect(carried.spawned).toBe('');
    const low = probedBuild('2026-10-22T08:01:00Z', ['--floor', committed, '--min-app-build', '10']);
    expect(low.run.status).not.toBe(0);
    expect(low.spawned).toBe('');
    expect(manifestBytes().equals(before)).toBe(true);

    const at = build('2026-10-22T08:02:00Z', ['--floor', committed, '--min-app-build', '11']);
    expect(at.status, at.stderr).toBe(0);
    expect(manifest().minAppBuild).toBe(11);
  }, 240_000);

  // PR 1218 R3: a floor file the build cannot read as a whole number fails closed, never passes.
  // A floor below 1 too (PR 1218 re-check N2, lead H29): no app build is below it, so it guards nothing.
  it('refuses a floor file without a whole-number minAppBuild of at least 1, and keeps the last manifest', () => {
    const before = manifestBytes();
    for (const [i, bad] of [{}, { minAppBuild: '11' }, { minAppBuild: 11.5 }, { minAppBuild: null }, { minAppBuild: 0 }].entries()) {
      const file = join(work, `bad-floor-${i}.json`);
      writeFileSync(file, JSON.stringify(bad));
      const { run, spawned } = probedBuild(`2026-10-22T09:0${i}:00Z`, ['--floor', file, '--min-app-build', '11']);
      expect(run.status, JSON.stringify(bad)).not.toBe(0);
      expect(run.stderr).toContain('must hold minAppBuild as a whole number');
      expect(spawned).toBe('');
      expect(manifestBytes().equals(before)).toBe(true);
    }
  }, 480_000);

  // TA-C01: the option checks run before the build, so a bad option starts no process at all.
  it('refuses a --min-version above this release, before building', () => {
    const before = manifestBytes();
    const { run, spawned } = probedBuild('2026-10-22T10:00:00Z', ['--min-version', '999999999999']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('--min-version must be a version at or below 202610221000');
    expect(spawned).toBe('');
    expect(manifestBytes().equals(before)).toBe(true);
  }, 120_000);

  it('refuses a --min-app-build below 1, before building', () => {
    const before = manifestBytes();
    const { run, spawned } = probedBuild('2026-10-22T10:01:00Z', ['--min-app-build', '0']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('--min-app-build must be a whole number of at least 1');
    expect(spawned).toBe('');
    expect(manifestBytes().equals(before)).toBe(true);
  }, 120_000);

  /** Runs the build WITHOUT --allow-dirty, with a stub `git` first on PATH that records its
   *  arguments and prints `status`. Returns the run and what git was asked. */
  function withStubGit(now: string, status: string, extra: string[] = []) {
    const bin = mkdtempSync(join(work, 'bin-'));
    const argv = join(bin, 'argv.log');
    writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> "${argv}"\nprintf '%s' '${status}'\n`, { mode: 0o755 });
    const clean: Record<string, string | undefined> = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete clean.ENGINE_SIGNING_KEY;
    const run = spawnSync(process.execPath, [script, '--out', out, '--keys', pinsFile, '--floor', floorFile, '--now', now, ...extra], {
      env: clean,
      encoding: 'utf8',
    });
    return { run, asked: existsSync(argv) ? readFileSync(argv, 'utf8') : '' };
  }

  // TA-C16: without --allow-dirty, uncommitted engine source stops the release.
  it('refuses uncommitted engine source without --allow-dirty', () => {
    const before = manifestBytes();
    const { run, asked } = withStubGit('2026-10-22T11:00:00Z', ' M ios/engine/entry.ts\n');
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Uncommitted engine source');
    expect(run.stderr).toContain('ios/engine/entry.ts');
    expect(asked.trim()).toBe('status --porcelain -- packages/health-core ios/engine');
    expect(manifestBytes().equals(before)).toBe(true);
  });

  it('a clean tree passes the dirty check (control: it fails later, on --min-version)', () => {
    const { run, asked } = withStubGit('2026-10-22T11:01:00Z', '', ['--min-version', '999999999999']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).not.toContain('Uncommitted engine source');
    expect(run.stderr).toContain('--min-version must be a version at or below');
    expect(asked.trim()).toBe('status --porcelain -- packages/health-core ios/engine');
  }, 120_000);
});
