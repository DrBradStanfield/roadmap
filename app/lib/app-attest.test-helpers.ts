/**
 * A fake Apple App Attest for tests (US-52): a test root CA, an intermediate,
 * and a leaf carrying the nonce extension, built with the openssl CLI, plus
 * the CBOR the phone would send. The verifier is pointed at this root instead
 * of Apple's. Proves our reading of the format is self-consistent; a real
 * device's attestation is still owed (D8, adversary R3).
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- minimal CBOR encoder (the decoder's subset) ---
function head(major: number, len: number): Buffer {
  if (len < 24) return Buffer.from([(major << 5) | len]);
  if (len < 256) return Buffer.from([(major << 5) | 24, len]);
  if (len < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(len, 1); return b; }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(len, 1); return b;
}
export function encodeCbor(v: unknown): Buffer {
  if (typeof v === 'number') return head(0, v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encodeCbor)]);
  if (v && typeof v === 'object') {
    const entries = Object.entries(v);
    return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, x]) => [encodeCbor(k), encodeCbor(x)])]);
  }
  throw new Error('unsupported');
}

const sha256 = (...p: Buffer[]) => { const h = crypto.createHash('sha256'); p.forEach((x) => h.update(x)); return h.digest(); };

export const AAGUID_PROD = Buffer.concat([Buffer.from('appattest'), Buffer.alloc(7)]);
export const AAGUID_DEV = Buffer.from('appattestdevelop');

function point(pub: crypto.KeyObject): Buffer {
  const jwk = pub.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
}

export interface FakeDevice {
  rootPem: string;
  keyId: string;
  privateKey: crypto.KeyObject;
  /** Builds the attestation object for `challenge`, with overrides to break one thing at a time. */
  attest(challenge: string, o?: { appId?: string; counter?: number; aaguid?: Buffer; nonce?: Buffer; credentialId?: Buffer; selfSignedLeaf?: boolean }): Buffer;
  /** Base64 CBOR assertion over the request, as `generateAssertion` returns it. */
  assert(clientData: Buffer, counter: number, appId: string): string;
}

const run = (dir: string, args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });

export function fakeDevice(appId: string): FakeDevice {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-attest-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  fs.writeFileSync(path.join(dir, 'leaf.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
  run(dir, ['ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', 'root.key']);
  run(dir, ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'int.key']);
  fs.writeFileSync(path.join(dir, 'ca.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
  run(dir, ['req', '-x509', '-new', '-key', 'root.key', '-subj', '/CN=Test App Attestation Root CA', '-days', '30', '-sha384', '-out', 'root.pem', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run(dir, ['req', '-new', '-key', 'int.key', '-subj', '/CN=Test App Attestation CA 1', '-out', 'int.csr']);
  run(dir, ['x509', '-req', '-in', 'int.csr', '-CA', 'root.pem', '-CAkey', 'root.key', '-CAcreateserial', '-days', '30', '-sha384', '-extfile', 'ca.ext', '-out', 'int.pem']);
  const rootPem = fs.readFileSync(path.join(dir, 'root.pem'), 'utf8');
  const keyId = sha256(point(publicKey)).toString('base64');
  let n = 0;

  const leafDer = (nonce: Buffer, selfSigned: boolean): Buffer => {
    n += 1;
    // OCTET STRING { SEQUENCE { [1] { OCTET STRING nonce } } }: the extension's value, as openssl's DER: wants it.
    const inner = Buffer.concat([Buffer.from([0x04, 0x20]), nonce]);
    const tagged = Buffer.concat([Buffer.from([0xa1, inner.length]), inner]);
    const seq = Buffer.concat([Buffer.from([0x30, tagged.length]), tagged]);
    fs.writeFileSync(path.join(dir, `leaf${n}.ext`), `basicConstraints=critical,CA:FALSE\n1.2.840.113635.100.8.2=DER:${seq.toString('hex')}\n`);
    run(dir, ['req', '-new', '-key', 'leaf.key', '-subj', '/CN=Test attested key', '-out', `leaf${n}.csr`]);
    if (selfSigned) run(dir, ['x509', '-req', '-in', `leaf${n}.csr`, '-key', 'leaf.key', '-days', '3', '-extfile', `leaf${n}.ext`, '-outform', 'DER', '-out', `leaf${n}.der`]);
    else run(dir, ['x509', '-req', '-in', `leaf${n}.csr`, '-CA', 'int.pem', '-CAkey', 'int.key', '-CAcreateserial', '-days', '3', '-extfile', `leaf${n}.ext`, '-outform', 'DER', '-out', `leaf${n}.der`]);
    return fs.readFileSync(path.join(dir, `leaf${n}.der`));
  };
  const intDer = () => { run(dir, ['x509', '-in', 'int.pem', '-outform', 'DER', '-out', 'int.der']); return fs.readFileSync(path.join(dir, 'int.der')); };

  return {
    rootPem,
    keyId,
    privateKey,
    attest(challenge, o = {}) {
      const credId = o.credentialId ?? sha256(point(publicKey));
      const counter = Buffer.alloc(4); counter.writeUInt32BE(o.counter ?? 0);
      const credLen = Buffer.alloc(2); credLen.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha256(Buffer.from(o.appId ?? appId)), Buffer.from([0x40]), counter, o.aaguid ?? AAGUID_PROD, credLen, credId, Buffer.from([0xa0])]);
      const nonce = o.nonce ?? sha256(authData, sha256(Buffer.from(challenge, 'utf8')));
      return encodeCbor({ fmt: 'apple-appattest', attStmt: { x5c: [leafDer(nonce, !!o.selfSignedLeaf), intDer()], receipt: Buffer.from('r') }, authData });
    },
    assert(clientData, counterValue, assertAppId) {
      const counter = Buffer.alloc(4); counter.writeUInt32BE(counterValue);
      const authenticatorData = Buffer.concat([sha256(Buffer.from(assertAppId)), Buffer.from([0x40]), counter]);
      const nonce = sha256(authenticatorData, sha256(clientData));
      const signature = crypto.sign('sha256', nonce, privateKey);
      return encodeCbor({ signature, authenticatorData }).toString('base64');
    },
  };
}
