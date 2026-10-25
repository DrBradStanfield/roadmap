/**
 * US-52 AC1: App Attest verification, against a test CA built with openssl
 * (app-attest.test-helpers.ts). Each refusal breaks exactly one thing.
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APPLE_APP_ATTEST_ROOT_PEM, assertionSignatureValid, attestConfig, challengeValid, decodeCbor,
  devBypassAllowed, newChallenge, parseAssertion, requestClientData, verifyAttestation, type AttestConfig,
} from './app-attest.server';
import { AAGUID_DEV, encodeCbor, fakeDevice } from './app-attest.test-helpers';

const APP_ID = 'TEAM123456.com.drstanfield.healthroadmap';
const env = { SHOPIFY_API_SECRET: 'test-secret' } as NodeJS.ProcessEnv;
const device = fakeDevice(APP_ID);
const config: AttestConfig = { appId: APP_ID, environments: ['production'], rootPem: device.rootPem };

const reason = (fn: () => unknown) => {
  try { fn(); } catch (e) { return (e as { reason?: string }).reason ?? String(e); }
  return 'passed';
};

describe('US-52 AC1: the pinned Apple root', () => {
  it('is Apple App Attestation Root CA, self-signed, with the recorded fingerprint', () => {
    const root = new crypto.X509Certificate(APPLE_APP_ATTEST_ROOT_PEM);
    expect(root.subject).toContain('Apple App Attestation Root CA');
    expect(root.verify(root.publicKey)).toBe(true);
    expect(root.fingerprint256).toBe('1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32');
  });
});

describe('US-52 AC1: challenges', () => {
  it('accepts its own fresh challenge and refuses an expired, altered or foreign one', () => {
    const c = newChallenge(1_000_000, env);
    expect(challengeValid(c, 1_000_000, env)).toBe(true);
    expect(challengeValid(c, 1_000_000 + 5 * 60_000 + 1, env)).toBe(false);
    const raw = Buffer.from(c, 'base64url'); raw[10] ^= 1;
    expect(challengeValid(raw.toString('base64url'), 1_000_000, env)).toBe(false);
    expect(challengeValid(newChallenge(1_000_000, { SHOPIFY_API_SECRET: 'other' } as NodeJS.ProcessEnv), 1_000_000, env)).toBe(false);
    expect(challengeValid(42, 1_000_000, env)).toBe(false);
  });
});

describe('US-52 AC1: attestation', () => {
  const challenge = newChallenge(Date.now(), env);

  it('accepts a genuine attestation and returns the key', () => {
    const key = verifyAttestation({ keyId: device.keyId, attestation: device.attest(challenge), challenge, config });
    expect(key.keyId).toBe(device.keyId);
    expect(key.environment).toBe('production');
    expect(key.publicKeyPem).toContain('BEGIN PUBLIC KEY');
  });

  it('refuses each broken part with its own reason', () => {
    const v = (attestation: Buffer, o: Partial<{ keyId: string; challenge: string; config: AttestConfig }> = {}) =>
      reason(() => verifyAttestation({ keyId: o.keyId ?? device.keyId, attestation, challenge: o.challenge ?? challenge, config: o.config ?? config }));
    expect(v(device.attest(challenge), { challenge: newChallenge(Date.now(), env) })).toBe('nonce_mismatch');
    expect(v(device.attest(challenge, { nonce: Buffer.alloc(32) }))).toBe('nonce_mismatch');
    expect(v(device.attest(challenge, { appId: 'OTHER.com.example' }))).toBe('app_id_mismatch');
    expect(v(device.attest(challenge, { counter: 1 }))).toBe('counter_not_zero');
    expect(v(device.attest(challenge, { aaguid: AAGUID_DEV }))).toBe('environment_refused');
    expect(v(device.attest(challenge, { credentialId: Buffer.alloc(32, 7) }))).toBe('credential_mismatch');
    expect(v(device.attest(challenge), { keyId: Buffer.alloc(32).toString('base64') })).toBe('key_id_mismatch');
    expect(v(device.attest(challenge, { selfSignedLeaf: true }))).toBe('bad_chain');
    // A chain that is perfect but not Apple's (the production root) fails.
    expect(v(device.attest(challenge), { config: { ...config, rootPem: APPLE_APP_ATTEST_ROOT_PEM } })).toBe('bad_chain');
    expect(v(encodeCbor({ fmt: 'packed', attStmt: {}, authData: Buffer.alloc(40) }))).toBe('bad_format');
    expect(v(Buffer.from([0xff]))).toBe('bad_cbor');
  });

  it('takes a development key only when development is allowed', () => {
    const dev = device.attest(challenge, { aaguid: AAGUID_DEV });
    const key = verifyAttestation({ keyId: device.keyId, attestation: dev, challenge, config: { ...config, environments: ['production', 'development'] } });
    expect(key.environment).toBe('development');
  });
});

describe('US-52 AC1: assertions', () => {
  const key = crypto.createPublicKey(device.privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const body = Buffer.from('{"message":"hello"}');
  const clientData = requestClientData('POST', '/api/app/v1/chat', body);

  it('binds method, path and the raw body bytes', () => {
    expect(clientData.toString()).toBe(`POST\n/api/app/v1/chat\n${crypto.createHash('sha256').update(body).digest('hex')}`);
  });

  it('verifies a genuine assertion and reads its counter', () => {
    const a = parseAssertion(device.assert(clientData, 7, APP_ID), APP_ID);
    expect(a.counter).toBe(7);
    expect(assertionSignatureValid(a, clientData, key)).toBe(true);
  });

  it('refuses another body, another path, another key and another app', () => {
    const a = parseAssertion(device.assert(clientData, 7, APP_ID), APP_ID);
    expect(assertionSignatureValid(a, requestClientData('POST', '/api/app/v1/chat', Buffer.from('{"message":"hellp"}')), key)).toBe(false);
    expect(assertionSignatureValid(a, requestClientData('POST', '/api/app/v1/lab-import', body), key)).toBe(false);
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(assertionSignatureValid(a, clientData, other)).toBe(false);
    expect(reason(() => parseAssertion(device.assert(clientData, 7, 'OTHER.app'), APP_ID))).toBe('app_id_mismatch');
    expect(reason(() => parseAssertion('AAAA', APP_ID))).toBe('bad_cbor');
  });
});

describe('US-52 AC2/AC3: config and the dev bypass', () => {
  it('has no config without a team id, and defaults the placeholder bundle id', () => {
    expect(attestConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(attestConfig({ APP_ATTEST_TEAM_ID: 'T1' } as NodeJS.ProcessEnv)?.appId).toBe('T1.com.drstanfield.healthroadmap');
    expect(attestConfig({ APP_ATTEST_TEAM_ID: 'T1', APP_ATTEST_ALLOW_DEVELOPMENT: '1' } as NodeJS.ProcessEnv)?.environments).toEqual(['production', 'development']);
  });

  it('opens the bypass only with the flag AND a development or test NODE_ENV', () => {
    const e = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;
    expect(devBypassAllowed(e({ APP_ATTEST_DEV_BYPASS: '1', NODE_ENV: 'development' }))).toBe(true);
    expect(devBypassAllowed(e({ APP_ATTEST_DEV_BYPASS: '1', NODE_ENV: 'test' }))).toBe(true);
    expect(devBypassAllowed(e({ APP_ATTEST_DEV_BYPASS: '1', NODE_ENV: 'production' }))).toBe(false);
    expect(devBypassAllowed(e({ APP_ATTEST_DEV_BYPASS: '1' }))).toBe(false);
    expect(devBypassAllowed(e({ NODE_ENV: 'development' }))).toBe(false);
  });
});

describe('CBOR subset', () => {
  it('round-trips what the phone sends and refuses trailing bytes', () => {
    const m = decodeCbor(encodeCbor({ a: 1, b: Buffer.from([1, 2]), c: ['x'] })) as Map<string, unknown>;
    expect(m.get('a')).toBe(1);
    expect(reason(() => decodeCbor(Buffer.concat([encodeCbor(1), Buffer.from([0])])))).toBe('bad_cbor');
  });
});
