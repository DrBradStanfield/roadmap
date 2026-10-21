// Ed25519 signing for over-the-air engine releases (ios/architecture.md D3,
// US-25 AC18). Shared by engine-keygen.mjs, release-engine.mjs and their tests.
// A signature covers DOMAIN + the manifest's exact bytes, so a signature made
// for anything else with the same key can never pass as a manifest's.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const DOMAIN = 'health-roadmap-engine-manifest/v1\n';
/** Where the daily key lives: the login Keychain, trusted by no app (-T ""), so
 *  every read asks Brad. The cold key lives only in 1Password. */
export const KEYCHAIN_SERVICE = 'health-roadmap-engine-signing';
/** macOS's own Keychain tool, by absolute path (review N4). */
export const SECURITY = '/usr/bin/security';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function privateKeyFromSeed(seed) {
  if (seed.length !== 32) throw new Error('An engine signing key is 32 bytes.');
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

/** The raw 32-byte public key for a seed. */
export function publicKeyOf(seed) {
  return createPublicKey(privateKeyFromSeed(seed)).export({ format: 'der', type: 'spki' }).subarray(-32);
}

/** First 16 hex digits of SHA-256 of the raw public key: what the docs and reports name. */
export function fingerprint(rawPublicKey) {
  return createHash('sha256').update(rawPublicKey).digest('hex').slice(0, 16);
}

export function signManifest(manifestBytes, seed) {
  return sign(null, Buffer.concat([Buffer.from(DOMAIN), manifestBytes]), privateKeyFromSeed(seed));
}

export function verifyManifest(manifestBytes, signature, rawPublicKey) {
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, rawPublicKey]), format: 'der', type: 'spki' });
  return verify(null, Buffer.concat([Buffer.from(DOMAIN), manifestBytes]), key, signature);
}

/** The manifest's bytes: keys sorted, no whitespace. The app refuses any other
 *  spelling (a duplicate key, an unknown field, padding), so the bytes signed
 *  are the only bytes that can mean this manifest. */
export function canonicalManifest(fields) {
  const sorted = Object.fromEntries(Object.keys(fields).sort().map((key) => [key, fields[key]]));
  return Buffer.from(JSON.stringify(sorted));
}

/** The seed for `keyId`: ENGINE_SIGNING_KEY (base64, CI or a cold-key run) or,
 *  for the daily key, the login Keychain (macOS asks Brad to allow the read). */
export function readSigningKey(keyId, env = process.env) {
  let text = env.ENGINE_SIGNING_KEY;
  if (!text) {
    if (keyId !== 'daily') throw new Error(`The ${keyId} key is not in the Keychain: put it in ENGINE_SIGNING_KEY from 1Password.`);
    try {
      // By absolute path: no PATH lookup can put another program between the key and us (N4).
      text = execFileSync(SECURITY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', keyId, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    } catch {
      throw new Error('No signing key: set ENGINE_SIGNING_KEY, or allow the Keychain read (run engine-keygen.mjs once first).');
    }
  }
  const seed = Buffer.from(text.trim(), 'base64');
  if (seed.length !== 32) throw new Error('The signing key is not a base64 32-byte seed.');
  return seed;
}
