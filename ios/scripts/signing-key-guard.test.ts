// US-25 AC18: the engine signing keys never enter the repo (ios/architecture.md D3).
// Fails on a key-shaped file name, an Ed25519 private key in PKCS#8 form, a
// stray file in the release folder, or, when a file-held key (cold, ci) is still on
// this Mac, its bytes in any tracked file. Nothing secret is ever printed.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(__dirname, '../..');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repo }).toString().split('\0').filter(Boolean);
// The file-held keys while they wait on this Mac for 1Password and GitHub.
const keyFiles = ['COLD-move-to-1password', 'CI-move-to-github-secret'].map((name) => join(homedir(), `.config/health-roadmap/engine-signing-key-${name}.txt`));

// A PKCS#8 Ed25519 private key: its header followed by the 32 key bytes, as DER hex
// or as base64 (a PEM body). The bare header (engine-signing.mjs) is not a key.
const ED25519_PRIVATE = [/302e020100300506032b657004220420[0-9a-f]{64}/i, /MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9+/]{22}/];

function contents(): Array<[string, string]> {
  return tracked
    .filter((file) => existsSync(join(repo, file)) && statSync(join(repo, file)).size < 8_000_000)
    .map((file) => [file, readFileSync(join(repo, file)).toString('latin1')]);
}

describe('engine signing key guard (US-25 AC18)', () => {
  it('no tracked file is named like a key', () => {
    const named = tracked.filter((file) => /signing-key(?!s\.json$)|\.pem$|\.p8$|\.p12$|\.key$|id_ed25519/i.test(file) && !file.endsWith('.test.ts'));
    expect(named).toEqual([]);
  });

  it('no tracked file holds an Ed25519 private key', () => {
    const found = contents().filter(([file, text]) => !file.endsWith('signing-key-guard.test.ts') && ED25519_PRIVATE.some((key) => key.test(text)));
    expect(found.map(([file]) => file)).toEqual([]);
  });

  it('the release folder holds only manifests, signatures and bundles', () => {
    const stray = tracked.filter((file) => file.startsWith('ios/engine-release/') && !/^ios\/engine-release\/bridge-[0-9a-f]{16}\/(manifest\.json|manifest\.sig|[0-9a-f]{64}\.js)$/.test(file));
    expect(stray).toEqual([]);
  });

  it.skipIf(!keyFiles.some((file) => existsSync(file)))('the file-held keys on this Mac are in no tracked file', () => {
    const files = contents();
    for (const file of keyFiles.filter((f) => existsSync(f))) {
      const seed = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
      const forms = [seed.toString('base64'), seed.toString('hex'), seed.toString('base64url')];
      const found = files.filter(([, text]) => forms.some((form) => text.includes(form)));
      expect(found.length, 'a tracked file holds a signing key').toBe(0);
    }
  });
});
