// US-73 AC14: `upload_labs_opened` counts presses of a My health heading's "Upload labs"
// button. Its metadata is which heading, a closed word, and nothing else: never a value.
import { describe, it, expect, vi } from 'vitest';
import { PRODUCT_EVENT_NAMES, SERVER_ONLY_EVENT_NAMES } from '../../packages/health-core/src/product-events';
import { parseProductEvent } from './product-events.server';

vi.mock('@sentry/react-router', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: null })) })) })),
}));

const VISITOR = '5f0e3e9a-6c1f-4b1a-9a3e-2d4c8b7a6f5e';
const event = (metadata?: object) => ({ eventName: 'upload_labs_opened', visitorId: VISITOR, ...(metadata ? { metadata } : {}) });

describe('upload_labs_opened (US-73 AC14)', () => {
  it('is a browser event', () => {
    expect(PRODUCT_EVENT_NAMES).toContain('upload_labs_opened');
    expect(SERVER_ONLY_EVENT_NAMES as readonly string[]).not.toContain('upload_labs_opened');
  });

  it('takes each of the three headings', () => {
    for (const placement of ['weight', 'cholesterol', 'bloodTests']) {
      expect(parseProductEvent(event({ placement }))).toEqual(event({ placement }));
    }
  });

  it('refuses another heading, another surface\'s placement, any other key, and a row without its heading', () => {
    for (const metadata of [
      { placement: 'supplements' },
      { placement: 'top_bar' },
      { placement: 'header' },
      { placement: 'weight', count: 1 },
      { placement: 'cholesterol', provider: 'dropbox' },
      { placement: 'bloodTests', ldl: 3.1 },
      {},
    ]) {
      expect(parseProductEvent(event(metadata)), JSON.stringify(metadata)).toBeNull();
    }
    expect(parseProductEvent(event())).toBeNull();
  });

  it('keeps its placements off the guide link and the sign-in', () => {
    for (const eventName of ['guide_opened', 'signin_opened']) {
      expect(parseProductEvent({ eventName, visitorId: VISITOR, metadata: { placement: 'weight' } }), eventName).toBeNull();
    }
  });
});
