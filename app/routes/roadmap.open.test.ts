import { describe, it, expect, vi, beforeEach } from 'vitest';

const recordServerEvent = vi.fn(async () => {});
vi.mock('../lib/product-events.server', () => ({
  recordServerEvent: (...a: unknown[]) => recordServerEvent(...(a as [])),
}));

import { EMAIL_LANDING_URL, ROADMAP_URL, loader } from './roadmap.open';
import { buildPlanReadyEmailHtml, buildReminderV2EmailHtml } from '../lib/email.server';

/**
 * US-22 AC5 — the plan-ready email's CTA destination.
 *
 * The destinations are literals. The first live version derived this URL from
 * SHOPIFY_STORE_URL and shipped two real defects in one line: a scheme-less
 * value on the edu app produced a RELATIVE redirect (404 on our own domain),
 * and appending /pages/roadmap 404s on microvitamin.com. If someone
 * reintroduces a computed or relative value, this fails.
 */
describe('US-22 roadmap CTA destination', () => {
  it('the bare page URL stays exact, because calendar event text shows it (US-24 AC2)', () => {
    expect(ROADMAP_URL).toBe('https://drstanfield.com/pages/roadmap');
  });

  it('the redirect target is its own literal, the same page with the email flag (US-22 AC13)', () => {
    expect(EMAIL_LANDING_URL).toBe('https://drstanfield.com/pages/roadmap?from=email');
  });
});

/**
 * US-22 AC13 + US-23 AC10 — both email buttons land on the tool with the email
 * flag, and each email's clicks are counted apart. The query only ever picks
 * WHICH counter, by exact equality; nothing in the request can reach Location,
 * so this route cannot become an open redirect.
 */
describe('GET /roadmap/open', () => {
  beforeEach(() => recordServerEvent.mockClear());

  const open = (query = '') =>
    loader({ request: new Request(`https://health-tool-app.fly.dev/roadmap/open${query}`) } as never);

  it('a plan-ready click is counted as report_email_clicked and lands on the flagged literal', async () => {
    const res = await open();
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe('https://drstanfield.com/pages/roadmap?from=email');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(recordServerEvent).toHaveBeenCalledTimes(1);
    expect(recordServerEvent).toHaveBeenCalledWith('report_email_clicked');
  });

  it('a reminder click (?src=reminder) gets its own counter and the same destination (US-23 AC10)', async () => {
    const res = await open('?src=reminder');
    expect(res.headers.get('Location')).toBe(EMAIL_LANDING_URL);
    expect(recordServerEvent).toHaveBeenCalledTimes(1);
    expect(recordServerEvent).toHaveBeenCalledWith('reminder_email_clicked');
  });

  it.each([
    '?src=https://evil.example/',
    '?src=reminder&next=//evil.example',
    '?from=https://evil.example&to=//evil.example#x',
    '?src=REMINDER',
    '?src=reminder%00',
    '?src=reminder%20',
  ])('request input never reaches Location, and only an exact "reminder" picks that counter: %s', async (query) => {
    const res = await open(query);
    expect(res.headers.get('Location')).toBe(EMAIL_LANDING_URL);
    const exactReminder = new URL(`https://x${query}`).searchParams.get('src') === 'reminder';
    expect(recordServerEvent).toHaveBeenCalledWith(exactReminder ? 'reminder_email_clicked' : 'report_email_clicked');
  });

  // The two ends of one contract live in two files: the href each email
  // renders, and the query this loader reads. Follow each email's REAL button,
  // so renaming either side alone fails here instead of miscounting silently.
  it.each([
    ['the plan-ready email', buildPlanReadyEmailHtml('guest'), 'report_email_clicked'],
    [
      'a reminder email',
      buildReminderV2EmailHtml([{ label: 'Colonoscopy', dueAt: '2026-08-01' }], 'https://x.example/unsubscribe'),
      'reminder_email_clicked',
    ],
  ])('%s: its own button reaches its own counter', async (_email, html, counter) => {
    const href = html.match(/href="([^"]*\/roadmap\/open[^"]*)"/)?.[1];
    expect(href).toBeDefined();
    const res = await loader({ request: new Request(href!) } as never);
    expect(res.headers.get('Location')).toBe(EMAIL_LANDING_URL);
    expect(recordServerEvent).toHaveBeenCalledWith(counter);
  });
});
