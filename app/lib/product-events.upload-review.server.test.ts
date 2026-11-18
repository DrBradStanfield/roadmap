// US-13 AC13: `upload_review` is a browser counter, one per import review end.
// Its metadata is UPLOAD_REVIEW_KEYS counts and nothing else: never a value,
// a test, a unit or a file name.
import { describe, it, expect, vi } from 'vitest';
import { PER_ACTION_EVENT_NAMES, PRODUCT_EVENT_NAMES, SERVER_ONLY_EVENT_NAMES, UPLOAD_OUTCOME_MAX } from '../../packages/health-core/src/product-events';
import { parseProductEvent } from './product-events.server';

const { captureMessage } = vi.hoisted(() => ({ captureMessage: vi.fn() }));
vi.mock('@sentry/react-router', () => ({ captureMessage, captureException: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: null })) })) })),
}));

const VISITOR = '5f0e3e9a-6c1f-4b1a-9a3e-2d4c8b7a6f5e';
const event = (metadata?: object) => ({ eventName: 'upload_review', visitorId: VISITOR, ...(metadata ? { metadata } : {}) });
const FULL = { sure: 12, unsure: 2, notSaved: 3, showAll: 1, notSavedOpened: 0, changedSure: 1, changedUnsure: 0, saved: 1 };

describe('upload_review (US-13 AC13)', () => {
  it('is a browser event sent on every review end, not once per tab', () => {
    expect(PRODUCT_EVENT_NAMES).toContain('upload_review');
    expect(SERVER_ONLY_EVENT_NAMES as readonly string[]).not.toContain('upload_review');
    expect(PER_ACTION_EVENT_NAMES as readonly string[]).toContain('upload_review');
  });

  it('takes its counts and flags', () => {
    expect(parseProductEvent(event(FULL))).toEqual(event(FULL));
    expect(parseProductEvent(event({ saved: 0 }))).toEqual(event({ saved: 0 }));
    expect(parseProductEvent(event({ sure: UPLOAD_OUTCOME_MAX, saved: 1 }))).toEqual(event({ sure: UPLOAD_OUTCOME_MAX, saved: 1 }));
  });

  it('refuses a count past the clamp, a flag above 1, text, a fraction, any other key, and a row without `saved`', () => {
    for (const metadata of [
      { ...FULL, sure: UPLOAD_OUTCOME_MAX + 1 },
      { ...FULL, showAll: 2 },
      { ...FULL, saved: 2 },
      { ...FULL, unsure: 1.5 },
      { ...FULL, notSaved: '3' },
      { ...FULL, count: 1 },
      { ...FULL, provider: 'dropbox' },
      { ...FULL, picked: 1 },
      { sure: 1 },
      {},
    ]) {
      expect(parseProductEvent(event(metadata))).toBeNull();
    }
    expect(parseProductEvent(event())).toBeNull();
  });

  it('no other event may carry its keys', () => {
    expect(parseProductEvent({ eventName: 'results_viewed', visitorId: VISITOR, metadata: { sure: 1 } })).toBeNull();
    expect(parseProductEvent({ eventName: 'upload_outcome', visitorId: VISITOR, metadata: { picked: 1, saved: 1 } })).toBeNull();
  });
});
