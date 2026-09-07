// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { calculateHealthResults } from '@roadmap/health-core';

const mocks = vi.hoisted(() => ({
  getReportHtml: vi.fn(),
  sendGuestReport: vi.fn(),
  getReportEmailCaptured: vi.fn(),
  markReportEmailCaptured: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('../lib/roadmap-data', () => mocks);
vi.mock('../lib/server-api', () => ({ trackABConversion: mocks.trackABConversion, trackProductEvent: vi.fn() }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
import { ResultsPanel } from './ResultsPanel';

const results = calculateHealthResults({ heightCm: 175, sex: 'male' });

function showPlan() {
  return render(<ResultsPanel results={results} isValid unitSystem="si" showEmailCapture formStage={2}
    syncControl={() => <div>Save in your own cloud</div>} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getReportEmailCaptured.mockReturnValue(false);
  mocks.getReportHtml.mockResolvedValue({ success: true, html: '<p>Local report</p>' });
  mocks.sendGuestReport.mockResolvedValue({ success: true });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('US-09 AC5 / US-23 AC4 — local-first capture after account removal', () => {
  it('prints locally before subscribing only the email, then shows the returning-user PDF action', async () => {
    const print = vi.fn();
    vi.spyOn(window, 'open').mockImplementation(() => ({ document: { write: vi.fn(), close: vi.fn() }, print }) as unknown as Window);
    mocks.sendGuestReport.mockImplementation(async (email) => {
      expect(print).toHaveBeenCalledOnce();
      expect(email).toBe('reader@example.com');
      return { success: true };
    });
    const view = showPlan();
    fireEvent.change(view.container.querySelector('#guestEmail')!, { target: { value: ' reader@example.com ' } });
    fireEvent.click(view.getAllByRole('button', { name: 'Get My Health Plan' })[0]);
    await waitFor(() => expect(view.getByRole('button', { name: 'Save as PDF' })).toBeTruthy());
    expect(mocks.sendGuestReport).toHaveBeenCalledWith('reader@example.com');
    expect(mocks.markReportEmailCaptured).toHaveBeenCalledOnce();
    expect(view.queryByPlaceholderText('Email')).toBeNull();
    expect(view.queryByText('Create Free Account')).toBeNull();
    expect(view.getByText('Save in your own cloud')).toBeTruthy();
  });

  it('keeps capture available after a subscription failure and never marks it captured', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    mocks.sendGuestReport.mockResolvedValue({ success: false, error: 'Please retry' });
    const view = showPlan();
    fireEvent.change(view.container.querySelector('#guestEmail')!, { target: { value: 'reader@example.com' } });
    fireEvent.click(view.getAllByRole('button', { name: 'Get My Health Plan' })[0]);
    await waitFor(() => expect(view.getAllByText('Please retry').length).toBeGreaterThan(0));
    expect(mocks.markReportEmailCaptured).not.toHaveBeenCalled();
    expect(view.queryByRole('button', { name: 'Save as PDF' })).toBeNull();
  });

  it('restores capture from the local record without asking for a Shopify account', () => {
    mocks.getReportEmailCaptured.mockReturnValue(true);
    const view = showPlan();
    expect(view.getByRole('button', { name: 'Save as PDF' })).toBeTruthy();
    expect(view.queryByPlaceholderText('Email')).toBeNull();
    expect(view.container.querySelector('a[href^="/account"]')).toBeNull();
  });
});
