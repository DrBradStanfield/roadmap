// @vitest-environment jsdom
/**
 * US-18 AC6a: the guest PDF box's email field is named and described for a
 * screen reader. Its name came only from the placeholder "Email", the helper
 * line above it was not tied to it, and a refused address or a failed send
 * was shown in a plain span nothing pointed at, so it was not announced.
 * Synthetic addresses only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { statTiles } from '@roadmap/health-core/stat-tiles';
import { calculateHealthResults } from '@roadmap/health-core/calculations';

const mocks = vi.hoisted(() => ({
  getReportHtml: vi.fn(),
  sendGuestReport: vi.fn(),
  getReportEmailCaptured: vi.fn(),
  markReportEmailCaptured: vi.fn(),
}));
vi.mock('../lib/roadmap-data', () => ({
  getReportHtml: mocks.getReportHtml,
  sendGuestReport: mocks.sendGuestReport,
  getReportEmailCaptured: mocks.getReportEmailCaptured,
  markReportEmailCaptured: mocks.markReportEmailCaptured,
  getShownErase: () => 'erase-1',
}));
vi.mock('../lib/server-api', () => ({ trackABConversion: vi.fn(), trackProductEvent: vi.fn() }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true }));
vi.mock('../lib/assistant-config', () => ({ getSkipEmailGate: () => false }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
import { PlanHost } from '../testing/plan-host';
import { GUEST_CAPTURE_BUTTON_LABEL, LOCAL_FIRST_EMAIL_HELPER } from './PlanPdf';

const results = calculateHealthResults({ heightCm: 175, sex: 'male' });
const showPlan = (formStage?: number) => render(
  <PlanHost results={results} isValid tiles={results ? statTiles(results, { unitSystem: 'si' }) : []} showEmailCapture formStage={formStage}/>,
);
const emailBox = () => screen.getByRole('textbox', { name: 'Email for your PDF' });
const description = (el: HTMLElement) => (el.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
  .map(id => document.getElementById(id)?.textContent ?? `<missing ${id}>`);
const send = (address: string) => {
  fireEvent.change(emailBox(), { target: { value: address } });
  fireEvent.click(screen.getByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL }));
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getReportEmailCaptured.mockReturnValue(false);
  mocks.getReportHtml.mockResolvedValue({ success: true, html: '<p>Local report</p>' });
  mocks.sendGuestReport.mockResolvedValue({ success: true });
  vi.spyOn(window, 'open').mockImplementation(() => ({ document: { write: vi.fn(), close: vi.fn() }, print: vi.fn() }) as unknown as Window);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('US-18 AC6a: the PDF email box is named and its errors are tied to it', () => {
  it('is named "Email for your PDF", not by its placeholder, and described by the helper line', () => {
    showPlan(3);
    const box = emailBox();
    expect(box.getAttribute('placeholder')).toBe('Email');
    expect(box.id).toBe('guestEmail');
    expect(description(box)).toEqual([LOCAL_FIRST_EMAIL_HELPER]);
    expect(box.getAttribute('aria-invalid')).toBe('false');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('has the same name and description where the box takes no id', () => {
    showPlan(undefined);
    const box = emailBox();
    expect(box.id).toBe('');
    expect(description(box)).toEqual([LOCAL_FIRST_EMAIL_HELPER]);
  });

  it('a refused address is announced and read with the box', () => {
    showPlan(3);
    send('not-an-email');
    expect(screen.getByRole('alert').textContent).toBe('Please enter a valid email address');
    expect(screen.getByRole('alert').className).toBe('email-capture-error');
    expect(description(emailBox())).toEqual([LOCAL_FIRST_EMAIL_HELPER, 'Please enter a valid email address']);
    expect(emailBox().getAttribute('aria-invalid')).toBe('true');
    expect(mocks.sendGuestReport).not.toHaveBeenCalled();
  });

  it('a failed send is announced and read with the box', async () => {
    mocks.sendGuestReport.mockResolvedValue({ success: false });
    showPlan(3);
    send('reader@example.com');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Failed to send. Please try again.'));
    expect(description(emailBox())).toEqual([LOCAL_FIRST_EMAIL_HELPER, 'Failed to send. Please try again.']);
    expect(emailBox().getAttribute('aria-invalid')).toBe('true');
  });

  it('typing again clears the error from the box and the page', () => {
    showPlan(3);
    send('not-an-email');
    fireEvent.change(emailBox(), { target: { value: 'reader@example.com' } });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(description(emailBox())).toEqual([LOCAL_FIRST_EMAIL_HELPER]);
    expect(emailBox().getAttribute('aria-invalid')).toBe('false');
  });
});
