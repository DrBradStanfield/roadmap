/**
 * Apple App Attest for the iPhone app's chat and lab upload (US-52,
 * ios/architecture.md D8). The app has no Shopify signature and no account, so
 * each request proves instead that it came from a genuine copy of the app:
 * a key attested once by Apple, then an assertion per request.
 *
 * Pure verification lives here; storage is a `KeyStore` (Supabase in
 * production, app-attest-store.server.ts). Every refusal is a closed reason
 * word: no key id, IP or request content reaches a log.
 */
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Apple App Attestation Root CA, pinned. Its SHA-256 fingerprint is
 * 1C:B9:82:3B:A2:8B:A6:AD:2D:33:A0:06:94:1D:E2:AE:4F:51:3E:F1:D4:E8:31:B9:F7:E0:FA:7B:62:42:C9:32
 * (self-signature checked 2026-10-21).
 */
export const APPLE_APP_ATTEST_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

export type AttestEnvironment = 'production' | 'development';

/** AAGUIDs Apple writes into authData: 16 bytes each. */
const AAGUID: Record<AttestEnvironment, Buffer> = {
  production: Buffer.concat([Buffer.from('appattest'), Buffer.alloc(7)]),
  development: Buffer.from('appattestdevelop'),
};

export interface AttestConfig {
  /** TEAMID.bundleid. */
  appId: string;
  /** Environments whose keys are accepted. Production always; development only by flag. */
  environments: AttestEnvironment[];
  rootPem: string;
}

/** Read at each use, never captured. Null when the team id is unset: the routes then answer 503 (AC2). */
export function attestConfig(env: NodeJS.ProcessEnv = process.env): AttestConfig | null {
  const team = env.APP_ATTEST_TEAM_ID?.trim();
  if (!team) return null;
  const bundle = env.APP_ATTEST_BUNDLE_ID?.trim() || 'com.drbrad.healthroadmap';
  return {
    appId: `${team}.${bundle}`,
    environments: env.APP_ATTEST_ALLOW_DEVELOPMENT === '1' ? ['production', 'development'] : ['production'],
    rootPem: APPLE_APP_ATTEST_ROOT_PEM,
  };
}

/**
 * The simulator bypass (AC3): the flag AND a development or test NODE_ENV, an
 * allow-list, so an unset NODE_ENV (a laptop `npm start`) never opens it.
 * Read through a computed key so no bundler can inline it at build time.
 */
export function devBypassAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  const nodeEnvKey = ['NODE', 'ENV'].join('_');
  const nodeEnv = env[nodeEnvKey];
  return env.APP_ATTEST_DEV_BYPASS === '1' && (nodeEnv === 'development' || nodeEnv === 'test');
}

export class AttestError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AttestError';
  }
}

const sha256 = (...parts: Uint8Array[]) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

// ---------------------------------------------------------------------------
// Challenges: stateless, HMAC'd, 5 minutes
// ---------------------------------------------------------------------------

const CHALLENGE_TTL_MS = 5 * 60_000;

function challengeKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const secret = env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error('SHOPIFY_API_SECRET is not configured');
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), 'app-attest-challenge/v1', 32));
}

/** base64url(expiry ms as 8 bytes || 16 random bytes || HMAC of both). */
export function newChallenge(now = Date.now(), env: NodeJS.ProcessEnv = process.env): string {
  const head = Buffer.alloc(24);
  head.writeBigUInt64BE(BigInt(now + CHALLENGE_TTL_MS), 0);
  crypto.randomBytes(16).copy(head, 8);
  const mac = crypto.createHmac('sha256', challengeKey(env)).update(head).digest();
  return Buffer.concat([head, mac]).toString('base64url');
}

export function challengeValid(challenge: unknown, now = Date.now(), env: NodeJS.ProcessEnv = process.env): boolean {
  if (typeof challenge !== 'string' || challenge.length > 100) return false;
  const raw = Buffer.from(challenge, 'base64url');
  if (raw.length !== 56) return false;
  const head = raw.subarray(0, 24);
  const mac = crypto.createHmac('sha256', challengeKey(env)).update(head).digest();
  if (!crypto.timingSafeEqual(mac, raw.subarray(24))) return false;
  return Number(head.readBigUInt64BE(0)) >= now;
}

// ---------------------------------------------------------------------------
// CBOR: the subset Apple's objects use (uint, bytes, text, array, map)
// ---------------------------------------------------------------------------

export function decodeCbor(bytes: Uint8Array): unknown {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const need = (n: number) => { if (at + n > buf.length) throw new AttestError('bad_cbor'); };
  const item = (depth: number): unknown => {
    if (depth > 8) throw new AttestError('bad_cbor');
    need(1);
    const first = buf[at++];
    const major = first >> 5;
    const info = first & 31;
    let len: number;
    if (info < 24) len = info;
    else if (info === 24) { need(1); len = buf[at]; at += 1; }
    else if (info === 25) { need(2); len = buf.readUInt16BE(at); at += 2; }
    else if (info === 26) { need(4); len = buf.readUInt32BE(at); at += 4; }
    else throw new AttestError('bad_cbor'); // 64-bit lengths and indefinite items: Apple uses neither
    switch (major) {
      case 0: return len;
      case 2: { need(len); const out = buf.subarray(at, at + len); at += len; return out; }
      case 3: { need(len); const out = buf.toString('utf8', at, at + len); at += len; return out; }
      case 4: { if (len > 16) throw new AttestError('bad_cbor'); return Array.from({ length: len }, () => item(depth + 1)); }
      case 5: {
        if (len > 16) throw new AttestError('bad_cbor');
        const map = new Map<unknown, unknown>();
        for (let i = 0; i < len; i++) { const k = item(depth + 1); map.set(k, item(depth + 1)); }
        return map;
      }
      default: throw new AttestError('bad_cbor');
    }
  };
  const value = item(0);
  if (at !== buf.length) throw new AttestError('bad_cbor');
  return value;
}

// ---------------------------------------------------------------------------
// authData
// ---------------------------------------------------------------------------

interface AuthData { rpIdHash: Buffer; counter: number; aaguid?: Buffer; credentialId?: Buffer }

function parseAuthData(data: Buffer, attested: boolean): AuthData {
  if (data.length < 37) throw new AttestError('bad_auth_data');
  const out: AuthData = { rpIdHash: data.subarray(0, 32), counter: data.readUInt32BE(33) };
  if (!attested) return out;
  if (data.length < 55) throw new AttestError('bad_auth_data');
  const credLen = data.readUInt16BE(53);
  if (data.length < 55 + credLen) throw new AttestError('bad_auth_data');
  return { ...out, aaguid: data.subarray(37, 53), credentialId: data.subarray(55, 55 + credLen) };
}

// ---------------------------------------------------------------------------
// The nonce extension: OID 1.2.840.113635.100.8.2 → OCTET STRING { SEQUENCE { [1] { OCTET STRING nonce } } }
// ---------------------------------------------------------------------------

const NONCE_OID = Buffer.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02]);

function readTlv(buf: Buffer, at: number): { tag: number; start: number; end: number } {
  if (at + 2 > buf.length) throw new AttestError('bad_nonce');
  const tag = buf[at];
  let len = buf[at + 1];
  let start = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3 || start + n > buf.length) throw new AttestError('bad_nonce');
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[start + i];
    start += n;
  }
  if (start + len > buf.length) throw new AttestError('bad_nonce');
  return { tag, start, end: start + len };
}

export function nonceFromCertificate(der: Buffer): Buffer {
  const oidAt = der.indexOf(NONCE_OID);
  if (oidAt < 0 || der.indexOf(NONCE_OID, oidAt + 1) >= 0) throw new AttestError('bad_nonce');
  let next = readTlv(der, oidAt + NONCE_OID.length);
  if (next.tag === 0x01) next = readTlv(der, next.end); // the optional "critical" flag
  if (next.tag !== 0x04) throw new AttestError('bad_nonce');
  const seq = readTlv(der, next.start);
  if (seq.tag !== 0x30) throw new AttestError('bad_nonce');
  const tagged = readTlv(der, seq.start);
  if (tagged.tag !== 0xa1) throw new AttestError('bad_nonce');
  const octets = readTlv(der, tagged.start);
  if (octets.tag !== 0x04 || octets.end - octets.start !== 32) throw new AttestError('bad_nonce');
  return der.subarray(octets.start, octets.end);
}

// ---------------------------------------------------------------------------
// Attestation (registration)
// ---------------------------------------------------------------------------

export interface AttestedKey {
  keyId: string;
  publicKeyPem: string;
  environment: AttestEnvironment;
}

function uncompressedPoint(key: crypto.KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new AttestError('bad_key');
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
}

function withinValidity(cert: crypto.X509Certificate, now: number): boolean {
  return Date.parse(cert.validFrom) <= now && now <= Date.parse(cert.validTo);
}

/**
 * Apple's server-side attestation check, steps 1 to 9. `keyId` is the app's
 * base64 key id; `challenge` the server challenge whose UTF-8 bytes the app
 * hashed into `clientDataHash`. Throws `AttestError` on any mismatch.
 */
export function verifyAttestation(opts: {
  keyId: string; attestation: Buffer; challenge: string; config: AttestConfig; now?: number;
}): AttestedKey {
  const now = opts.now ?? Date.now();
  const obj = decodeCbor(opts.attestation);
  if (!(obj instanceof Map) || obj.get('fmt') !== 'apple-appattest') throw new AttestError('bad_format');
  const attStmt = obj.get('attStmt');
  const authDataRaw = obj.get('authData');
  if (!(attStmt instanceof Map) || !Buffer.isBuffer(authDataRaw)) throw new AttestError('bad_format');
  const x5c = attStmt.get('x5c');
  if (!Array.isArray(x5c) || x5c.length < 2 || !x5c.every(Buffer.isBuffer)) throw new AttestError('bad_format');

  // 1. The chain: leaf ← intermediate ← the pinned root, each in date.
  let leaf: crypto.X509Certificate, intermediate: crypto.X509Certificate;
  const root = new crypto.X509Certificate(opts.config.rootPem);
  try {
    leaf = new crypto.X509Certificate(x5c[0] as Buffer);
    intermediate = new crypto.X509Certificate(x5c[1] as Buffer);
  } catch { throw new AttestError('bad_certificate'); }
  if (!leaf.verify(intermediate.publicKey) || !intermediate.verify(root.publicKey)
    || !leaf.checkIssued(intermediate) || !intermediate.checkIssued(root)
    || !intermediate.ca || leaf.ca) throw new AttestError('bad_chain');
  if (![leaf, intermediate, root].every((c) => withinValidity(c, now))) throw new AttestError('certificate_expired');

  // 2–4. nonce = SHA256(authData || SHA256(challenge)) must be the leaf's extension.
  const clientDataHash = sha256(Buffer.from(opts.challenge, 'utf8'));
  const nonce = sha256(authDataRaw, clientDataHash);
  if (!crypto.timingSafeEqual(nonce, nonceFromCertificate(Buffer.from(leaf.raw)))) throw new AttestError('nonce_mismatch');

  // 5. The key id is the hash of the certified public key.
  const point = uncompressedPoint(leaf.publicKey);
  const keyId = sha256(point).toString('base64');
  if (keyId !== opts.keyId) throw new AttestError('key_id_mismatch');

  // 6–9. authData: this app, a fresh counter, a known environment, this key.
  const auth = parseAuthData(authDataRaw, true);
  if (!auth.rpIdHash.equals(sha256(Buffer.from(opts.config.appId, 'utf8')))) throw new AttestError('app_id_mismatch');
  if (auth.counter !== 0) throw new AttestError('counter_not_zero');
  const environment = opts.config.environments.find((e) => auth.aaguid!.equals(AAGUID[e]));
  if (!environment) throw new AttestError('environment_refused');
  if (!auth.credentialId!.equals(sha256(point))) throw new AttestError('credential_mismatch');

  return { keyId, publicKeyPem: leaf.publicKey.export({ type: 'spki', format: 'pem' }).toString(), environment };
}

// ---------------------------------------------------------------------------
// Assertions (every request)
// ---------------------------------------------------------------------------

/** What the app signs for one request: method, path and the body's hash (D8). */
export function requestClientData(method: string, path: string, body: Uint8Array): Buffer {
  return Buffer.from(`${method.toUpperCase()}\n${path}\n${sha256(body).toString('hex')}`, 'utf8');
}

export interface ParsedAssertion { signature: Buffer; authenticatorData: Buffer; counter: number }

/** The cheap part, before the body is read (D8: header shape, CBOR, this app's rpIdHash). */
export function parseAssertion(header: string, appId: string): ParsedAssertion {
  if (header.length > 4096) throw new AttestError('bad_assertion');
  const obj = decodeCbor(Buffer.from(header, 'base64'));
  if (!(obj instanceof Map)) throw new AttestError('bad_assertion');
  const signature = obj.get('signature');
  const authenticatorData = obj.get('authenticatorData');
  if (!Buffer.isBuffer(signature) || !Buffer.isBuffer(authenticatorData)) throw new AttestError('bad_assertion');
  const auth = parseAuthData(authenticatorData, false);
  if (!auth.rpIdHash.equals(sha256(Buffer.from(appId, 'utf8')))) throw new AttestError('app_id_mismatch');
  return { signature, authenticatorData, counter: auth.counter };
}

/** ECDSA P-256 over nonce = SHA256(authenticatorData || SHA256(clientData)); `verify('sha256')` hashes the nonce once more, as Apple's key signs it. */
export function assertionSignatureValid(a: ParsedAssertion, clientData: Buffer, publicKeyPem: string): boolean {
  const nonce = sha256(a.authenticatorData, sha256(clientData));
  try {
    return crypto.verify('sha256', nonce, publicKeyPem, a.signature);
  } catch {
    return false;
  }
}

/** A base64 key id: the 32-byte SHA-256 the app reports. */
export function validKeyId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value);
}
