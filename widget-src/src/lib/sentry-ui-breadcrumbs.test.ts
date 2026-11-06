// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createElement } from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { Sentry, scrubBreadcrumb, scrubEvent } from './sentry';
import { addMeasurement, flushRoadmapStore } from './roadmap-data';
import { seedGuest } from '../testing/health-tool-harness';

vi.mock('./server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('./chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('../components/ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('../components/ChatSection', () => ({ ChatSection: () => null }));
vi.mock('../components/UploadModal', () => ({ UploadModal: () => null }));
import { HealthTool } from '../components/HealthTool';

// US-09 AC7d end to end: real jsdom clicks and keystrokes through the real
// breadcrumbsIntegration, with initSentry's two hooks, out through a capturing
// transport. The sent event may name each element by tag, #id and its
// value-free classes only.
afterEach(async () => {
  cleanup();
  await flushRoadmapStore();
  await Sentry.close();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

/** Sentry as initSentry starts it, sending to `envelopes`. */
function startSentry(envelopes: unknown[]) {
  vi.stubGlobal('crypto', webcrypto);
  Sentry.getCurrentScope().clear();
  Sentry.getIsolationScope().clear();
  Sentry.init({
    dsn: 'https://public@example.invalid/1',
    defaultIntegrations: [Sentry.breadcrumbsIntegration()],
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSend: scrubEvent,
    transport: () => ({
      send: async envelope => { envelopes.push(envelope); return { statusCode: 200 }; },
      flush: async () => true,
    }),
  });
}

it('sends click and input breadcrumbs without labels, names, values or status classes', async () => {
  const envelopes: unknown[] = [];
  startSentry(envelopes);
  document.body.innerHTML = `
    <div class="bt-review"><label class="bt-replace"><input class="bt-replace-check" type="checkbox"
      aria-label="Replace the saved zinc value 0.4 weird with 0.7 weird"></label></div>
    <div id="annot" data-sentry-component="ReviewRow"><button aria-label="Zinc 0.4 weird">x</button></div>
    <input id="t" class="txt" name="LEAKNAME" title="LEAKTITLE 0.4 weird">
    <div class="stat-card"><span class="stat-status status-urgent" title="Diabetic">Diabetic</span></div>
    <span class="review-doc-type-badge review-doc-type--discharge_summary">Discharge summary</span>
    <svg class="ico" aria-label="SVGLEAK 0.4 weird"><path aria-label="PATHLEAK"></path></svg>
    <div id="host"></div>`;
  const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  click(document.querySelector('.bt-replace-check')!);
  click(document.querySelector('#annot button')!);
  document.querySelector('#t')!.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: 'a' }));
  click(document.querySelector('.stat-status')!);
  click(document.querySelector('.review-doc-type-badge')!);
  click(document.querySelector('svg path')!);
  const shadow = document.querySelector('#host')!.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<button class="sh" aria-label="SHADOWLEAK 0.4 weird">y</button>';
  click(shadow.querySelector('button')!);
  Sentry.captureException(new Error('x is undefined'), { tags: { area: 'results' } });
  await Sentry.flush();

  expect(envelopes).toHaveLength(1);
  const [, items] = envelopes[0] as [unknown, Array<[unknown, { breadcrumbs?: Sentry.Breadcrumb[] }]>];
  expect(items[0][1].breadcrumbs!.map(({ category, message, data }) => ({ category, message, data }))).toEqual([
    { category: 'ui.click', message: 'body > div.bt-review > label.bt-replace > input.bt-replace-check', data: undefined },
    { category: 'ui.click', message: 'body > div#annot > button', data: undefined },
    { category: 'ui.input', message: 'body > input#t.txt', data: undefined },
    { category: 'ui.click', message: 'body > div.stat-card > span.stat-status', data: undefined },
    { category: 'ui.click', message: 'body > span.review-doc-type-badge', data: undefined },
    { category: 'ui.click', message: 'body > svg > path', data: undefined },
    // A shadow-root click retargets to its host.
    { category: 'ui.click', message: 'body > div#host', data: undefined },
  ]);
  // The bare value 0.4 is checked in what the page supplies (breadcrumbs,
  // tags, exception), not in Sentry's own ids and timestamps, where "0.4" can
  // turn up by chance ("…10.405Z" failed the CI deploy gate, 2026-10-23; a
  // breadcrumb's own epoch timestamp "1792729010.481" did the same locally).
  const [, [[, event]]] = envelopes[0] as [unknown, Array<[unknown, Record<string, unknown>]>];
  const breadcrumbs = (event.breadcrumbs as Array<Record<string, unknown>>).map(({ timestamp: _sentryClock, ...rest }) => rest);
  const supplied = JSON.stringify({ breadcrumbs, tags: event.tags, exception: event.exception });
  expect(supplied, '0.4').not.toContain('0.4');
  const sent = JSON.stringify(envelopes);
  for (const leak of ['weird', 'zinc', 'Zinc', 'LEAK', 'aria-label', 'ReviewRow', 'Diabetic', 'urgent', 'discharge']) {
    expect(sent, leak).not.toContain(leak);
  }
});

// US-09 AC7d on My health (US-62 phase 5): the real page, an urgent plan, and
// clicks on what a finding draws. No card id, status class or suggestion id
// may name what the plan found.
it('My health: a card body, its Urgent label, the banner, a nav dot and the alcohol Dismiss send no finding', async () => {
  const envelopes: unknown[] = [];
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width'), media: q, addEventListener() {}, removeEventListener() {} }));
  Element.prototype.scrollIntoView ??= () => {};
  await seedGuest({ sex: 'male', heightCm: 178, birthYear: 1968, birthMonth: 6, unitSystem: 'si' },
    [['weight', 100], ['systolic_bp', 162], ['diastolic_bp', 101]], [], '2026-10-12');
  await addMeasurement('hba1c', 50, '2026-10-12');
  await flushRoadmapStore();
  const view = render(createElement(HealthTool));
  await waitFor(() => expect(view.container.querySelector('.mh-banner')).not.toBeNull());
  startSentry(envelopes);
  const root = view.container;
  const urgentCard = root.querySelector('.mh-card .suggestion-urgent')!;
  fireEvent.click(urgentCard.querySelector('.suggestion-body p')!);
  fireEvent.click(urgentCard.querySelector('.mh-status')!);
  fireEvent.click(root.querySelector('.mh-banner')!);
  fireEvent.click(root.querySelector('.mh-nav-dot')!);
  const dismiss = [...root.querySelectorAll('button')].find(b => b.textContent === 'Dismiss')!;
  expect(dismiss).toBeDefined();
  fireEvent.click(dismiss);
  Sentry.captureException(new Error('x is undefined'), { tags: { area: 'results' } });
  await Sentry.flush();

  expect(envelopes).toHaveLength(1);
  const [, items] = envelopes[0] as [unknown, Array<[unknown, { breadcrumbs?: Sentry.Breadcrumb[] }]>];
  const clicks = items[0][1].breadcrumbs!.filter(b => b.category === 'ui.click').map(b => b.message!);
  expect(clicks).toHaveLength(5);
  for (const path of clicks) {
    expect(path, path).not.toMatch(/hba1c|diabet|pressure|hypert|alcohol|urgent|attention|banner|nav-dot|hr-card/i);
  }
  // The card is named by its place alone; the banner and the dot by their tag.
  expect(clicks[0]).toMatch(/div#mh-card-\d+\.mh-card > /);
  expect(clicks[2]).toMatch(/ > button$/);
});
