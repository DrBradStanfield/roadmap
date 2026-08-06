import { describe, it, expect } from 'vitest';
import { scrubEvent } from './sentry';
import type * as Sentry from '@sentry/react';

function makeEvent(overrides: Partial<Sentry.ErrorEvent>): Sentry.ErrorEvent {
  return { type: undefined, ...overrides } as Sentry.ErrorEvent;
}

describe('scrubEvent — SDK self-noise filter', () => {
  // Regression: Sentry 7620498452 / 7645126135 — when a third-party error
  // (e.g. the Horizon theme's "@shopify/events" module-specifier TypeError)
  // is dropped by our own event processors, the SDK's internal
  // "An event processor returned `null`, will not send event." log object can
  // escape as a rejected plain object and get re-captured as
  // "Object captured as exception with keys: message". Pure self-noise — drop it.
  it('drops the SDK-internal "event processor returned null" self-capture', () => {
    const event = makeEvent({
      exception: {
        values: [{ type: 'Error', value: 'Object captured as exception with keys: message' }],
      },
      extra: {
        __serialized__: { message: 'An event processor returned `null`, will not send event.' },
      },
    });
    expect(scrubEvent(event)).toBeNull();
  });

  it('keeps real errors that merely carry a serialized message', () => {
    const event = makeEvent({
      exception: {
        values: [{ type: 'Error', value: 'Chat sendMessage failed' }],
      },
      extra: {
        __serialized__: { message: 'some app-level detail' },
      },
    });
    expect(scrubEvent(event)).not.toBeNull();
  });

  it('still drops frameless non-Error unhandled rejections (existing rule)', () => {
    const event = makeEvent({
      exception: {
        values: [{
          type: 'UnhandledRejection',
          value: 'Non-Error promise rejection captured',
          mechanism: { type: 'onunhandledrejection', handled: false },
        }],
      },
    });
    expect(scrubEvent(event)).toBeNull();
  });
});
