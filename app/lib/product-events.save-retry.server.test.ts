// US-09 AC30 (lead A1 step e): `save_retry` is a browser counter of one retry
// of a failed cloud save. Its metadata is its trigger and its outcome, closed
// words, and nothing else: never a value, a provider or a count.
import { describe, it, expect, vi } from 'vitest';
import { PER_ACTION_EVENT_NAMES, PRODUCT_EVENT_NAMES, SERVER_ONLY_EVENT_NAMES } from '../../packages/health-core/src/product-events';
import { parseProductEvent } from './product-events.server';

const { captureMessage } = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('@sentry/react-router', () => ({ captureMessage, captureException: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: null })) })) })),
}));

const VISITOR = '5f0e3e9a-6c1f-4b1a-9a3e-2d4c8b7a6f5e';
const event = (metadata?: object) => ({ eventName: 'save_retry', visitorId: VISITOR, ...(metadata ? { metadata } : {}) });

describe('save_retry (US-09 AC30)', () => {
  it('is a browser event sent on every retry, not once per tab', () => {
    expect(PRODUCT_EVENT_NAMES).toContain('save_retry');
    expect(SERVER_ONLY_EVENT_NAMES as readonly string[]).not.toContain('save_retry');
    expect(PER_ACTION_EVENT_NAMES as readonly string[]).toContain('save_retry');
  });

  it('takes each trigger with each outcome', () => {
    for (const trigger of ['online', 'focus']) {
      for (const outcome of ['landed', 'failed']) {
        expect(parseProductEvent(event({ trigger, outcome }))).toEqual(event({ trigger, outcome }));
      }
    }
  });

  it('refuses any other word, any other key, and a row without its trigger', () => {
    for (const metadata of [
      { trigger: 'poll', outcome: 'landed' },
      { trigger: 'online', outcome: 'ok' },
      { trigger: 'online', outcome: 'landed', provider: 'dropbox' },
      { trigger: 'online', outcome: 'landed', count: 1 },
      { outcome: 'landed' },
      {},
    ]) {
      expect(parseProductEvent(event(metadata))).toBeNull();
    }
    expect(parseProductEvent(event())).toBeNull();
  });

  it('no other event may carry its trigger or its outcome words', () => {
    expect(parseProductEvent({ eventName: 'results_viewed', visitorId: VISITOR, metadata: { trigger: 'online' } })).toBeNull();
    expect(parseProductEvent({ eventName: 'results_viewed', visitorId: VISITOR, metadata: { outcome: 'landed' } })).toBeNull();
  });
});
