// US-09 AC55: `cloud_connect_checked` is a browser counter of one account
// check of a cloud sign-in coming back to this browser's backend. Its metadata
// is the provider and the outcome, closed words, and nothing else: never an
// account id, an email or a count.
import { describe, it, expect, vi } from 'vitest';
import { CLOUD_CHECK_OUTCOMES, PER_ACTION_EVENT_NAMES, PRODUCT_EVENT_NAMES, SERVER_ONLY_EVENT_NAMES } from '../../packages/health-core/src/product-events';
import { parseProductEvent } from './product-events.server';

const { captureMessage } = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('@sentry/react-router', () => ({ captureMessage, captureException: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: null })) })) })),
}));

const VISITOR = '5f0e3e9a-6c1f-4b1a-9a3e-2d4c8b7a6f5e';
const event = (metadata?: object) => ({ eventName: 'cloud_connect_checked', visitorId: VISITOR, ...(metadata ? { metadata } : {}) });

describe('cloud_connect_checked (US-09 AC55)', () => {
  it('is a browser event sent on every check, not once per tab', () => {
    expect(PRODUCT_EVENT_NAMES).toContain('cloud_connect_checked');
    expect(SERVER_ONLY_EVENT_NAMES as readonly string[]).not.toContain('cloud_connect_checked');
    expect(PER_ACTION_EVENT_NAMES as readonly string[]).toContain('cloud_connect_checked');
  });

  it('takes each provider that is checked with each outcome', () => {
    expect([...CLOUD_CHECK_OUTCOMES]).toEqual(['same_account', 'no_pin_empty_copy', 'no_pin_same_record', 'other_account', 'no_pin_unproven', 'account_not_named']);
    for (const provider of ['google-drive', 'dropbox']) {
      for (const outcome of CLOUD_CHECK_OUTCOMES) {
        expect(parseProductEvent(event({ provider, outcome }))).toEqual(event({ provider, outcome }));
      }
    }
  });

  it('refuses any other word, any other key, and a row without its provider or its outcome', () => {
    for (const metadata of [
      { provider: 'dropbox', outcome: 'landed' },
      { provider: 'dropbox', outcome: 'ok' },
      { provider: 'dropbox', outcome: 'perm-aaaa' },
      { provider: 'someone', outcome: 'same_account' },
      { provider: 'dropbox', outcome: 'same_account', count: 1 },
      { provider: 'dropbox', outcome: 'same_account', account: 'perm-aaaa' },
      { provider: 'dropbox', outcome: 'same_account', trigger: 'online' },
      { outcome: 'same_account' },
      { provider: 'dropbox' },
      {},
    ]) {
      expect(parseProductEvent(event(metadata))).toBeNull();
    }
    expect(parseProductEvent(event())).toBeNull();
  });

  it('no other event may carry its outcome words', () => {
    for (const eventName of ['cloud_connect_refused', 'save_retry', 'results_viewed']) {
      expect(parseProductEvent({ eventName, visitorId: VISITOR, metadata: { provider: 'dropbox', outcome: 'other_account' } })).toBeNull();
    }
  });
});
