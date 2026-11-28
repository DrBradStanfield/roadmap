// US-09 AC67: `cloud_identity_read` and `drive_record_copies` are browser
// counters whose metadata is closed words only: never an id, an email, a file
// id or a body.
import { describe, it, expect, vi } from 'vitest';
import { PER_ACTION_EVENT_NAMES, PRODUCT_EVENT_NAMES, SERVER_ONLY_EVENT_NAMES } from '../../packages/health-core/src/product-events';
import { COPIES_OUTCOMES, IDENTITY_GRANTS, IDENTITY_GRANTS_BY_PROVIDER, IDENTITY_OUTCOMES, IDENTITY_PROVIDERS } from '../../packages/health-core/src/cloud-identity';
import { parseProductEvent } from './product-events.server';

vi.mock('@sentry/react-router', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: null })) })) })),
}));

const VISITOR = '5f0e3e9a-6c1f-4b1a-9a3e-2d4c8b7a6f5e';
const read = (metadata?: object) => ({ eventName: 'cloud_identity_read', visitorId: VISITOR, ...(metadata ? { metadata } : {}) });
const copies = (metadata?: object) => ({ eventName: 'drive_record_copies', visitorId: VISITOR, ...(metadata ? { metadata } : {}) });

describe('US-09 AC67 event shapes', () => {
  it('are browser events, sent each time the caller sends them (its own day key limits them)', () => {
    for (const name of ['cloud_identity_read', 'drive_record_copies']) {
      expect(PRODUCT_EVENT_NAMES as readonly string[]).toContain(name);
      expect(SERVER_ONLY_EVENT_NAMES as readonly string[]).not.toContain(name);
      expect(PER_ACTION_EVENT_NAMES as readonly string[]).toContain(name);
    }
  });

  it('cloud_identity_read takes every outcome with each grant its provider can hold, and refuses the rest', () => {
    expect(IDENTITY_GRANTS_BY_PROVIDER).toEqual({ 'google-drive': ['refreshable', 'access_only'], dropbox: ['refreshable'], github: ['pat'] });
    for (const provider of IDENTITY_PROVIDERS) for (const grant of IDENTITY_GRANTS) for (const outcome of IDENTITY_OUTCOMES) {
      const fits = (IDENTITY_GRANTS_BY_PROVIDER[provider] as readonly string[]).includes(grant);
      expect(parseProductEvent(read({ provider, grant, outcome }))).toEqual(fits ? read({ provider, grant, outcome }) : null);
    }
  });

  it('cloud_identity_read refuses another provider, a missing key, any other key or word', () => {
    for (const metadata of [
      { provider: 'webdav', grant: 'pat', outcome: 'ok' },
      { provider: 'local', grant: 'pat', outcome: 'ok' },
      { provider: 'dropbox', grant: 'refreshable' },
      { provider: 'dropbox', outcome: 'ok' },
      { grant: 'refreshable', outcome: 'ok' },
      { provider: 'dropbox', grant: 'oauth', outcome: 'ok' },
      { provider: 'dropbox', grant: 'redirect', outcome: 'ok' }, // the retired words
      { provider: 'google-drive', grant: 'popup', outcome: 'ok' },
      { provider: 'dropbox', grant: 'refreshable', outcome: 'landed' },
      { provider: 'dropbox', grant: 'refreshable', outcome: 'incomplete' },
      { provider: 'dropbox', grant: 'refreshable', outcome: 'ok', count: 1 },
      { provider: 'dropbox', grant: 'refreshable', outcome: 'ok', accountId: 'dbid:test' },
      { provider: 'dropbox', grant: 'refreshable', outcome: 'ok', owned: '1' },
      {},
    ]) {
      expect(parseProductEvent(read(metadata))).toBeNull();
    }
    expect(parseProductEvent(read())).toBeNull();
  });

  it('cloud_identity_read takes tokenReply from Dropbox, and goes without it', () => {
    for (const tokenReply of ['had_id', 'no_id']) {
      const m = { provider: 'dropbox', grant: 'refreshable', outcome: 'ok', tokenReply };
      expect(parseProductEvent(read(m))).toEqual(read(m));
    }
    expect(parseProductEvent(read({ provider: 'dropbox', grant: 'refreshable', outcome: 'ok' }))).toEqual(read({ provider: 'dropbox', grant: 'refreshable', outcome: 'ok' }));
  });

  it('tokenReply is refused from any other provider, as another word, or on another event', () => {
    for (const metadata of [
      { provider: 'google-drive', grant: 'refreshable', outcome: 'ok', tokenReply: 'had_id' },
      { provider: 'github', grant: 'pat', outcome: 'ok', tokenReply: 'no_id' },
      { provider: 'google-drive', grant: 'access_only', outcome: 'ok', tokenReply: 'had_id' },
      { provider: 'dropbox', grant: 'refreshable', outcome: 'ok', tokenReply: 'dbid:test' },
      { provider: 'dropbox', grant: 'refreshable', outcome: 'ok', tokenReply: true },
    ]) {
      expect(parseProductEvent(read(metadata))).toBeNull();
    }
    expect(parseProductEvent(copies({ outcome: 'refused', tokenReply: 'had_id' }))).toBeNull();
  });

  it('drive_record_copies takes both buckets on ok and on incomplete, none on a failure', () => {
    expect(parseProductEvent(copies({ owned: '1', notOwned: '0', outcome: 'ok' }))).toEqual(copies({ owned: '1', notOwned: '0', outcome: 'ok' }));
    expect(parseProductEvent(copies({ owned: '2+', notOwned: '1', outcome: 'incomplete' }))).toEqual(copies({ owned: '2+', notOwned: '1', outcome: 'incomplete' }));
    for (const outcome of COPIES_OUTCOMES.filter((o) => o !== 'ok')) {
      expect(parseProductEvent(copies({ outcome }))).toEqual(copies({ outcome }));
    }
  });

  it('drive_record_copies refuses half a pair, counts on a failure, none on ok, and anything else', () => {
    for (const metadata of [
      { owned: '1', outcome: 'ok' },
      { notOwned: '1', outcome: 'incomplete' },
      { outcome: 'ok' },
      { owned: '1', notOwned: '0', outcome: 'refused' },
      { owned: '1', notOwned: '0', outcome: 'unreachable' },
      { owned: '3', notOwned: '0', outcome: 'ok' },
      { owned: 1, notOwned: 0, outcome: 'ok' },
      { owned: '1', notOwned: '0', outcome: 'skipped' },
      { owned: '1', notOwned: '0', outcome: 'ok', provider: 'google-drive' },
      { owned: '1', notOwned: '0', outcome: 'ok', fileId: 'x' },
      {},
    ]) {
      expect(parseProductEvent(copies(metadata))).toBeNull();
    }
  });

  it('no other event may carry their keys or words', () => {
    expect(parseProductEvent({ eventName: 'results_viewed', visitorId: VISITOR, metadata: { grant: 'pat' } })).toBeNull();
    expect(parseProductEvent({ eventName: 'results_viewed', visitorId: VISITOR, metadata: { owned: '1' } })).toBeNull();
    expect(parseProductEvent({ eventName: 'save_retry', visitorId: VISITOR, metadata: { trigger: 'online', outcome: 'skipped' } })).toBeNull();
  });
});
