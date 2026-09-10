// @vitest-environment jsdom
/**
 * US-05 / US-09 — what the GitHub Pages (self-host) build must NOT show, and
 * the one privacy link both builds must show.
 *
 * K2: the privacy notice was reachable only from the MCP consent screen. The
 * plan footer links to it now, so both builds carry it.
 * K6d: FeedbackForm POSTs to /api/feedback, which does not exist on Pages —
 * the form used to render there and fail after submit.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { calculateHealthResults } from '@roadmap/health-core';

vi.mock('../lib/roadmap-data', () => ({
  getReportHtml: vi.fn(),
  sendGuestReport: vi.fn(),
  getReportEmailCaptured: () => false,
  markReportEmailCaptured: vi.fn(),
}));
vi.mock('../lib/server-api', () => ({
  trackABConversion: vi.fn(),
  trackProductEvent: vi.fn(),
  sendFeedback: vi.fn(),
}));

const results = calculateHealthResults({ heightCm: 175, sex: 'male' });

async function renderPlan(shopify: boolean) {
  vi.resetModules();
  vi.doMock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: shopify, LOCAL_FIRST: true }));
  const { ResultsPanel } = await import('./ResultsPanel');
  return render(<ResultsPanel results={results} isValid unitSystem="si" formStage={2} />);
}

afterEach(() => { cleanup(); vi.doUnmock('../lib/build-flags'); vi.resetModules(); });

describe('US-05 — the privacy notice is linked from the plan footer', () => {
  it.each([true, false])('renders the link with its href (Shopify surface: %s)', async (shopify) => {
    const view = await renderPlan(shopify);
    const link = view.getByText('How your health data is handled') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('https://drstanfield.com/pages/connector-privacy');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});

describe('US-09 — feedback is Shopify-surface only', () => {
  it('renders the feedback form on the Shopify surface', async () => {
    const view = await renderPlan(true);
    expect(view.container.querySelector('.feedback-section')).toBeTruthy();
  });

  it('drops the feedback form on the Pages build', async () => {
    const view = await renderPlan(false);
    expect(view.container.querySelector('.feedback-section')).toBeNull();
  });
});
