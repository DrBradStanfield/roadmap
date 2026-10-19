import { describe, it, expect } from 'vitest';
import { scrubBreadcrumb, scrubEvent } from './sentry';
import type * as Sentry from '@sentry/react';

function makeEvent(overrides: Partial<Sentry.ErrorEvent>): Sentry.ErrorEvent {
  return { type: undefined, ...overrides } as Sentry.ErrorEvent;
}

// US-13 AC9: a review that throws while rendering reports through the strict
// branch, so nothing the review showed (values, units, names typed into
// labels) leaves the browser. Synthetic values.
describe('scrubEvent — the upload review boundary (feature upload_review)', () => {
  it('keeps the tag, and no number survives anywhere in the event', () => {
    const event = makeEvent({
      message: 'Review failed at 0.4',
      tags: { feature: 'upload_review', metric: 'zinc 0.4' },
      exception: { values: [{ type: 'TypeError', value: "Cannot read properties of undefined (reading 'padStart') at 0.4 weird", mechanism: { type: 'generic', handled: true } }] },
      breadcrumbs: [{ category: 'ui.click', message: 'button[aria-label="Replace the saved Zinc value 0.4 weird with 0.7 weird"]', data: { value: 0.7 } }],
      extra: { componentStack: 'at Cell (value 0.4)' },
      contexts: { review: { value: 0.7 } },
      request: { url: 'https://example.test/pages/roadmap?value=0.4', data: '0.4' },
    });
    const scrubbed = scrubEvent(event);
    expect(scrubbed?.tags).toEqual({ feature: 'upload_review' });
    expect(JSON.stringify(scrubbed)).not.toMatch(/\d/);
  });
});

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

// The same free-text gap the server audit found (2026-09-10) applies in the
// browser: the widget uses the shared scrub, so this is a wiring test.
describe('scrubEvent — free-text scrub', () => {
  const AUDIT = 'My LDL is 3.2 mmol/L and I have diabetes';

  it('scrubs the exception value, extra strings and breadcrumbs, keeping frames', () => {
    const event = makeEvent({
      exception: {
        values: [{
          type: 'ValidationError',
          value: AUDIT,
          stacktrace: { frames: [{ filename: 'https://cdn.shopify.com/x/health-plan-v2.js', lineno: 7 }] },
        }],
      },
      extra: { message: AUDIT, mailto: 'brad@example.com' },
      breadcrumbs: [{ category: 'navigation', message: 'cholesterol 200' }],
    });
    const out = scrubEvent(event)!;
    expect(out.exception!.values![0].value).toBe('My LDL is [value] and I have diabetes');
    expect(out.exception!.values![0].type).toBe('ValidationError');
    expect(out.exception!.values![0].stacktrace!.frames![0].filename)
      .toBe('https://cdn.shopify.com/x/health-plan-v2.js');
    expect(out.extra!.message).toBe('My LDL is [value] and I have diabetes');
    expect(out.extra!.mailto).toBe('[email]');
    expect(out.breadcrumbs![0].message).toBe('cholesterol [value]');
  });
});

// The OAuth return lands on `/roadmap/?code=…&state=…`, and dropbox.ts /
// drive.ts call history.replaceState to clear it. The SDK records a navigation
// breadcrumb first, with the live authorization code in `data.from`/`data.to`.
describe('scrubEvent — navigation breadcrumbs', () => {
  it('drops the OAuth query from navigation from/to, absolute and relative', () => {
    const event = makeEvent({
      breadcrumbs: [
        { category: 'navigation', data: { from: '/roadmap/?code=abc&state=xyz', to: '/roadmap/' } },
        {
          category: 'navigation',
          data: {
            from: 'https://drstanfield.com/roadmap/?code=abc&state=xyz',
            to: 'https://drstanfield.com/roadmap/',
          },
        },
      ],
    });
    const out = scrubEvent(event)!;
    for (const crumb of out.breadcrumbs!) {
      const serialized = JSON.stringify(crumb.data);
      expect(serialized).not.toContain('code');
      expect(serialized).not.toContain('state');
      expect(serialized).not.toContain('abc');
      expect(serialized).not.toContain('xyz');
      expect(serialized).not.toContain('?');
    }
    expect(out.breadcrumbs![0].data).toEqual({ from: '/roadmap/', to: '/roadmap/' });
    expect(out.breadcrumbs![1].data).toEqual({
      from: 'https://drstanfield.com/roadmap/',
      to: 'https://drstanfield.com/roadmap/',
    });
  });
});

// US-09 AC7d: the SDK names a clicked or typed-in element by its aria-label,
// type, name, title and alt. The upload review's Replace checkbox was labelled
// "Replace the saved <name> value <old> with <new>" until US-13 AC10; any label
// may still quote a value, and scrubText misses
// values in units it does not know. Only tag, id and classes may leave.
describe('scrubBreadcrumb — ui.click and ui.input element names', () => {
  const LABEL = 'Replace the saved zinc value 0.4 weird with 0.7 weird';
  const PATH = 'div.bt-review > label.bt-replace > input.bt-replace-check';
  const sdkMessage = (label: string) =>
    `div.bt-review > label.bt-replace > input.bt-replace-check[type="checkbox"][aria-label="${label}"]`;
  const leaks = (text: string | undefined) => {
    expect(text).not.toMatch(/\d/);
    for (const word of ['Replace', 'zinc', 'weird', 'aria-label', 'checkbox']) expect(text).not.toContain(word);
  };
  // The element chain the SDK walks, as plain objects (no DOM in this suite).
  const element = (tagName: string, className: string, parentNode: unknown, id = '') =>
    ({ tagName, id, className, parentNode, getAttribute: () => LABEL });
  const input = element('INPUT', 'bt-replace-check',
    element('LABEL', 'bt-replace', element('DIV', 'bt-review', element('BODY', '', element('HTML', '', null)))));

  it.each(['ui.click', 'ui.input'])('%s keeps no label text or value without the element', category => {
    const out = scrubBreadcrumb({ category, message: sdkMessage(LABEL), data: { 'ui.component_name': LABEL } })!;
    expect(out.message).toBe(PATH);
    leaks(out.message);
    expect(out.data).toBeUndefined();
  });

  it.each(['ui.click', 'ui.input'])('%s rebuilds the path from the event target', category => {
    const out = scrubBreadcrumb({ category, message: sdkMessage(LABEL) }, { event: { target: input } })!;
    expect(out.message).toBe('body > div.bt-review > label.bt-replace > input.bt-replace-check');
    leaks(out.message);
  });

  it('a quote or bracket inside the label cannot carry text past the cut', () => {
    const hostile = 'Replace zinc 0.4 weird"] > span.x[title="0.7 weird] > b';
    const out = scrubBreadcrumb({ category: 'ui.click', message: sdkMessage(hostile) })!;
    expect(out.message).toBe(PATH);
    leaks(out.message);
  });

  // A class can say what the element shows: a result's status, a suggestion's
  // priority, a document's type, a lab group. Those classes go; the rest stay.
  const VALUE_CLASSES = 'status-urgent bt-status-bad review-doc-type--discharge_summary '
    + 'health-record-type--lab_report suggestion-urgent alr-group-icon--thyroid';
  const KEPT = 'body > div.hr-panel > span.stat-status';

  it('drops value-encoding classes from the rebuilt path', () => {
    const badge = element('SPAN', `stat-status ${VALUE_CLASSES}`,
      element('DIV', 'hr-panel bt-status-bad', element('BODY', '', null)));
    const out = scrubBreadcrumb({ category: 'ui.click', message: 'x' }, { event: { target: badge } })!;
    expect(out.message).toBe(KEPT);
  });

  it('drops value-encoding classes in the no-target fallback, before the cut too', () => {
    const message = `body > div.hr-panel.bt-status-bad > span.stat-status.${VALUE_CLASSES.split(' ').join('.')}`
      + '[aria-label="Diabetic"]';
    const out = scrubBreadcrumb({ category: 'ui.click', message })!;
    expect(out.message).toBe(KEPT);
  });

  it('leaves other categories as they were', () => {
    const crumbs = [
      { category: 'sentry.event', message: 'input[aria-label="x 0.4"]', data: { a: 1 } },
      { category: 'ui.blur', message: 'input[aria-label="x 0.4"]' },
    ];
    for (const crumb of crumbs) expect(scrubBreadcrumb({ ...crumb })).toEqual(crumb);
  });

  it('runs on the general scrub path, not only the strict areas', () => {
    const event = makeEvent({
      tags: { area: 'results' },
      exception: { values: [{ type: 'TypeError', value: 'x is undefined' }] },
      breadcrumbs: [
        { category: 'ui.click', message: sdkMessage(LABEL) },
        { category: 'ui.input', message: sdkMessage('Zinc value 0.4 weird with 0.7 x10^9/L') },
      ],
    });
    const out = scrubEvent(event)!;
    expect(out.breadcrumbs).toHaveLength(2);
    for (const crumb of out.breadcrumbs!) {
      expect(crumb.message).toBe(PATH);
      leaks(crumb.message);
    }
  });
});
