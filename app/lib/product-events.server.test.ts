import { describe, it, expect } from 'vitest';
import { PRODUCT_EVENT_NAMES, SERVER_ONLY_EVENT_NAMES } from '../../packages/health-core/src/product-events';
import { parseProductEvent, SERVER_VISITOR_ID } from './product-events.server';

const VISITOR = '5f0e3e9a-6c1f-4b1a-9a3e-2d4c8b7a6f5e';
const SERVER_ONLY = new Set<string>(SERVER_ONLY_EVENT_NAMES);

describe('parseProductEvent', () => {
  it('accepts every client-emittable event name', () => {
    for (const eventName of PRODUCT_EVENT_NAMES) {
      if (SERVER_ONLY.has(eventName)) continue;
      expect(parseProductEvent({ eventName, visitorId: VISITOR })).toEqual({
        eventName,
        visitorId: VISITOR,
      });
    }
  });

  // Adversarial review 2026-08-30: server-originated counters (reminder_sent,
  // report_email_*) were browser-forgeable through api.events, byte-identical
  // to the real cron/webhook rows — the loop reads these as evidence.
  it('rejects server-only event names from the client route', () => {
    for (const eventName of SERVER_ONLY_EVENT_NAMES) {
      expect(parseProductEvent({ eventName, visitorId: VISITOR })).toBeNull();
    }
  });

  it('rejects the server sentinel visitor id from the client route', () => {
    expect(parseProductEvent({ eventName: 'chat_opened', visitorId: SERVER_VISITOR_ID })).toBeNull();
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
