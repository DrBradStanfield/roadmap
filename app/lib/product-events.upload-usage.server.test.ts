// US-12 AC10: `upload_outcome`'s usage counts (design §7, R9): `known`,
// `failedFinal` and `firstReadSeconds`, integers from 0 to 1000 and nothing else.
import { describe, it, expect, vi } from 'vitest';
import { parseProductEvent } from './product-events.server';

vi.mock('@sentry/react-router', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({ from: vi.fn(() => ({ insert: vi.fn(async () => ({ error: null })) })) })),
}));

const VISITOR = '5f0e3e9a-6c1f-4b1a-9a3e-2d4c8b7a6f5e';
const outcome = (metadata: object) => parseProductEvent({ eventName: 'upload_outcome', visitorId: VISITOR, metadata });

describe('US-12 AC10: upload_outcome usage counts', () => {
  it('takes the three counts, 0 to 1000', () => {
    const metadata = { picked: 12, known: 3, failedFinal: 1, firstReadSeconds: 0 };
    expect(outcome(metadata)).toMatchObject({ metadata });
    expect(outcome({ picked: 1, firstReadSeconds: 1000, known: 1000, failedFinal: 1000 })).not.toBeNull();
  });

  it.each(['known', 'failedFinal', 'firstReadSeconds'])('refuses %s as anything but a whole number from 0 to 1000', (key) => {
    for (const bad of [-1, 1.5, 1001, '3', true, null]) {
      expect(outcome({ picked: 1, [key]: bad }), `${key}=${JSON.stringify(bad)}`).toBeNull();
    }
  });

  it('refuses an unknown key beside them, and the counts on another event', () => {
    for (const metadata of [{ known: 1, fileName: 'a.pdf' }, { known: 1, hash: 'abc' }, { failedFinal: 1, reason: 'timeout' }, { firstReadSeconds: 3, firstReadMs: 3000 }]) {
      expect(outcome(metadata), JSON.stringify(metadata)).toBeNull();
    }
    expect(parseProductEvent({ eventName: 'upload_review', visitorId: VISITOR, metadata: { saved: 1, known: 1 } })).toBeNull();
    expect(parseProductEvent({ eventName: 'chat_opened', visitorId: VISITOR, metadata: { failedFinal: 1 } })).toBeNull();
  });
});
