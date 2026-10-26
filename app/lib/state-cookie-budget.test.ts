// US-32 AC14: accepted opaque state survives the complete consent reseal.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { checkAuthorize, sealState } from './mcp-authorize.server';
import { KNOWN_CLIENTS } from './mcp-clients.server';
import { packSealed, unpackSealed } from './mcp-seal.server';
import { STATE_LIFETIME_SECONDS, type StatePayload } from './mcp-grants.server';
const client = KNOWN_CLIENTS.get('https://chatgpt.com/oauth/client.json')!;
const cookie = (sealed: string) => `__Host-mcp-state=${sealed}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${STATE_LIFETIME_SECONDS}`;
beforeEach(() => {
 process.env.MCP_ISSUER = 'https://mcp.example.test';
 process.env.MCP_SEAL_KEYS = Buffer.alloc(32, 9).toString('base64');
});
afterEach(() => { delete process.env.MCP_ISSUER; delete process.env.MCP_SEAL_KEYS; });
function authorize(state: string) {
 return checkAuthorize(new URLSearchParams({client_id: client.clientId, redirect_uri: client.redirectUris[0], response_type: 'code', code_challenge_method: 'S256', code_challenge: 'v'.repeat(43), state}), client);
}
describe('US-32 AC14 cookie budget', () => {
 it.each(['"'.repeat(1024), '\\'.repeat(1024), 'é'.repeat(1024), '⚡'.repeat(1024)])('refuses a state whose serialized bytes exceed the cookie budget', (state) => {
  // Quotes/backslashes are RFC6749 VSCHAR, not a Unicode-only protocol anomaly.
  expect(authorize(state)).toMatchObject({ok: false, error: 'invalid_request', reason: 'state-too-long'});
 });
 it.each(['S'.repeat(1024), 'relay-'.repeat(87), 'é'.repeat(200)])('preserves allowed bytes across both providers and random consent nonces', (state) => {
  const checked = authorize(state);
  expect(checked.ok).toBe(true);
  if (!checked.ok) throw Error('unexpected refusal');
  for (const provider of ['dropbox', 'google'] as const) {
   const now = Date.now();
   const initial = sealState(checked.request, provider, now);
   const payload = unpackSealed<StatePayload>('state', initial, now)!;
   expect(payload.clientState).toBe(state);
   for (let i=0;i<8;i++) {
    const sealed = packSealed('state', payload.clientId, {...payload, nonce: crypto.randomBytes(32).toString('base64url')});
    expect(Buffer.byteLength(cookie(sealed))).toBeLessThanOrEqual(4096);
    expect(unpackSealed<StatePayload>('state', sealed, now)?.clientState).toBe(state);
   }
  }
 });
 it('refuses an over-character-cap state', () => { expect(authorize('a'.repeat(1025)).ok).toBe(false); });
});
