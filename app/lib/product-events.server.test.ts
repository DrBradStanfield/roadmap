import { describe, it, expect } from 'vitest';
import { PRODUCT_EVENT_NAMES } from '../../packages/health-core/src/product-events';
import { parseProductEvent } from './product-events.server';

const VISITOR = '5f0e3e9a-6c1f-4b1a-9a3e-2d4c8b7a6f5e';

describe('parseProductEvent', () => {
  it('accepts every shared event name', () => {
    for (const eventName of PRODUCT_EVENT_NAMES) {
      expect(parseProductEvent({ eventName, visitorId: VISITOR })).toEqual({
        eventName,
        visitorId: VISITOR,
      });
    }
  });

  it('rejects unknown event names (client/server enum drift)', () => {
    expect(parseProductEvent({ eventName: 'made_up_event', visitorId: VISITOR })).toBeNull();
  });

  it('rejects a non-UUID visitor id', () => {
    expect(parseProductEvent({ eventName: 'chat_opened', visitorId: 'not-a-uuid' })).toBeNull();
  });

  it('accepts allow-listed metadata', () => {
    expect(
      parseProductEvent({
        eventName: 'cloud_connect_success',
        visitorId: VISITOR,
        metadata: { provider: 'dropbox' },
      }),
    ).toMatchObject({ metadata: { provider: 'dropbox' } });
    expect(
      parseProductEvent({
        eventName: 'upload_saved',
        visitorId: VISITOR,
        metadata: { count: 12 },
      }),
    ).toMatchObject({ metadata: { count: 12 } });
  });

  it('rejects metadata outside the allow-list (no free text, no health values)', () => {
    expect(
      parseProductEvent({
        eventName: 'upload_saved',
        visitorId: VISITOR,
        metadata: { note: 'my LDL is 4.2' },
      }),
    ).toBeNull();
    expect(
      parseProductEvent({
        eventName: 'cloud_connect_success',
        visitorId: VISITOR,
        metadata: { provider: 'icloud' },
      }),
    ).toBeNull();
    expect(
      parseProductEvent({
        eventName: 'upload_saved',
        visitorId: VISITOR,
        metadata: { count: 5.5 },
      }),
    ).toBeNull();
  });

  it('rejects missing fields', () => {
    expect(parseProductEvent({ eventName: 'chat_opened' })).toBeNull();
    expect(parseProductEvent({ visitorId: VISITOR })).toBeNull();
    expect(parseProductEvent(null)).toBeNull();
  });
});
