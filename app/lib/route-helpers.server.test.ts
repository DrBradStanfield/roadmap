import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// route-helpers.server.ts imports shopify.server.ts, which boots the whole
// Shopify app (env validation + a live Postgres session-storage connection) at
// module load — impossible in unit tests. Stub it, and the Supabase user
// lookup getAuthenticatedUser reaches only after a customer is identified.
const mocks = vi.hoisted(() => ({ appProxy: vi.fn(), getOrCreateSupabaseUser: vi.fn(async () => 'user-1') }));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: mocks.appProxy } } }));
vi.mock('./supabase.server', () => ({
  getOrCreateSupabaseUser: mocks.getOrCreateSupabaseUser,
  createUserClient: vi.fn(() => ({})),
}));

import { getAuthenticatedUser, getCustomerId, isValidUuid } from './route-helpers.server';
import { forgedQuery, proxyPairs, signedQuery, TEST_PROXY_SECRET } from './app-proxy.test-helpers';

let savedSecret: string | undefined;
beforeAll(() => {
  savedSecret = process.env.SHOPIFY_API_SECRET;
  process.env.SHOPIFY_API_SECRET = TEST_PROXY_SECRET;
});
afterAll(() => {
  process.env.SHOPIFY_API_SECRET = savedSecret;
});

describe('getCustomerId', () => {
  function makeRequest(query: string): Request {
    return new Request(`https://example.com/api/measurements${query}`);
  }
  const signedFor = (customer: string) => makeRequest(signedQuery(proxyPairs(customer)));

  it('extracts numeric customer ID from a signed proxy query', () => {
    expect(getCustomerId(signedFor('12345'))).toBe('12345');
  });

  it('returns null when parameter is missing', () => {
    expect(getCustomerId(makeRequest(signedQuery(proxyPairs('').slice(1))))).toBeNull();
  });

  it('rejects non-numeric customer ID', () => {
    expect(getCustomerId(signedFor('abc'))).toBeNull();
  });

  it('rejects customer ID with special characters', () => {
    expect(getCustomerId(signedFor('123; DROP TABLE'))).toBeNull();
  });

  it('rejects empty customer ID', () => {
    expect(getCustomerId(signedFor(''))).toBeNull();
  });

  it('rejects customer ID with spaces', () => {
    expect(getCustomerId(signedFor('123 456'))).toBeNull();
  });

  // US-09 AC24: the id comes only from a query Shopify signed.
  it('rejects an unsigned or wrongly signed query', () => {
    expect(getCustomerId(makeRequest('?logged_in_customer_id=12345'))).toBeNull();
    expect(getCustomerId(makeRequest(signedQuery(proxyPairs('12345'), 'wrong-secret')))).toBeNull();
  });

  it('rejects a duplicated logged_in_customer_id (the victim id put first)', () => {
    expect(getCustomerId(makeRequest(forgedQuery('999', '111')))).toBeNull();
    expect(getCustomerId(makeRequest(forgedQuery('999', '')))).toBeNull();
  });
});

describe('getAuthenticatedUser (US-09 AC24)', () => {
  it('never identifies a duplicated-id query, even when the proxy check passes', async () => {
    const graphql = vi.fn();
    mocks.appProxy.mockResolvedValue({ admin: { graphql } });
    const req = new Request(`https://health-tool-app.fly.dev/api/chat${forgedQuery('999', '111')}`);
    expect(await getAuthenticatedUser(req)).toBeNull();
    expect(graphql).not.toHaveBeenCalled();
    expect(mocks.getOrCreateSupabaseUser).not.toHaveBeenCalled();
  });

  it('identifies a single-value signed query', async () => {
    const graphql = vi.fn(async () => ({ json: async () => ({ data: { customer: { email: 'a@example.com', firstName: null, lastName: null } } }) }));
    mocks.appProxy.mockResolvedValue({ admin: { graphql } });
    const req = new Request(`https://health-tool-app.fly.dev/api/chat${signedQuery(proxyPairs('111'))}`);
    expect(await getAuthenticatedUser(req)).toMatchObject({ customerId: '111', userId: 'user-1' });
  });
});

describe('isValidUuid', () => {
  it('accepts valid UUID v4', () => {
    expect(isValidUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidUuid('')).toBe(false);
  });

  it('rejects non-UUID string', () => {
    expect(isValidUuid('not-a-uuid')).toBe(false);
  });

  it('rejects UUID with uppercase (tokens are lowercase hex)', () => {
    expect(isValidUuid('550E8400-E29B-41D4-A716-446655440000')).toBe(false);
  });

  it('rejects very long string', () => {
    expect(isValidUuid('a'.repeat(1000))).toBe(false);
  });

  it('rejects SQL injection attempt', () => {
    expect(isValidUuid("'; DROP TABLE profiles; --")).toBe(false);
  });
});

