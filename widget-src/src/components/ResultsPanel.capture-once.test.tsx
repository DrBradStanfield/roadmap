// @vitest-environment jsdom
/**
 * US-18 AC7: one capture per send. While the address is being enrolled, a
 * second Enter in the email box (or the reminders box, US-44) opens no second
 * print window and sends nothing more; after a failed send, the box works again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { statTiles } from '@roadmap/health-core/stat-tiles';
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { calculateHealthResults } from '@roadmap/health-core/calculations';

const mocks = vi.hoisted(() => ({
  getReportHtml: vi.fn(),
  sendGuestReport: vi.fn(),
  getReportEmailCaptured: vi.fn(),
  markReportEmailCaptured: vi.fn(),
  trackABConversion: vi.fn(),
  trackProductEvent: vi.fn(),
  skip: { value: false },
  shopify: { value: true },
}));
vi.mock('../lib/roadmap-data', () => ({
  getReportHtml: mocks.getReportHtml,
  sendGuestReport: mocks.sendGuestReport,
  getReportEmailCaptured: mocks.getReportEmailCaptured,
  markReportEmailCaptured: mocks.markReportEmailCaptured,
  getShownErase: () => 'erase-1',
}));
vi.mock('../lib/server-api', () => ({ trackABConversion: mocks.trackABConversion, trackProductEvent: mocks.trackProductEvent }));
vi.mock('../lib/build-flags', () => ({ get SHOPIFY_SURFACE() { return mocks.shopify.value; } }));
vi.mock('../lib/assistant-config', () => ({ getSkipEmailGate: () => mocks.skip.value }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
import { usePlanView } from './ResultsPanel';
import { REMINDER_SIGNUP_DONE } from './PlanPdf';
import { PlanHost as ResultsPanel } from '../testing/plan-host';

const results = calculateHealthResults({ heightCm: 175, sex: 'male' });

function plan(props: Partial<React.ComponentProps<typeof ResultsPanel>> = {}) {
  return (
    <ResultsPanel results={results} isValid tiles={results ? statTiles(results, { unitSystem: 'si' }) : []} showEmailCapture formStage={3} {...props} />
  );
}
function showPlan(props: Partial<React.ComponentProps<typeof ResultsPanel>> = {}) {
  return render(plan(props));
}

/** Draws plan.pdf in one of two places, as My health does (inside the full form, or below it). */
function MovingPdfHost({ inForm }: { inForm: boolean }) {
  const plan = usePlanView({ results, shownErase: '', isValid: true, tiles: [], forms: { medications: [], screenings: [] }, showEmailCapture: true, formStage: 3 });
  return inForm ? <div className="in-form">{plan.pdf}</div> : <section className="below-form">{plan.pdf}</section>;
}

let print: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.skip.value = true;
  mocks.shopify.value = true;
  mocks.getReportEmailCaptured.mockReturnValue(false);
  mocks.markReportEmailCaptured.mockImplementation(() => {});
  mocks.getReportHtml.mockResolvedValue({ success: true, html: '<p>Local report</p>' });
  mocks.sendGuestReport.mockResolvedValue({ success: true });
  print = vi.fn();
  vi.spyOn(window, 'open').mockImplementation(() => ({ document: { write: vi.fn(), close: vi.fn() }, print }) as unknown as Window);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); });



/** sendGuestReport held open until `settle` is called. */
function pendingSend() {
  let settle: (r: { success: boolean; error?: string }) => void = () => {};
  mocks.sendGuestReport.mockImplementation(() => new Promise((r) => { settle = r; }));
  return (r: { success: boolean; error?: string }) => settle(r);
}
const enter = (el: Element) => fireEvent.keyDown(el, { key: 'Enter' });
/** The box holding this input (the panel renders the capture more than once). */
const box = (input: Element) => within(input.closest('.email-capture') as HTMLElement);

describe('US-18 AC7: the email box sends once per press', () => {
  beforeEach(() => { mocks.skip.value = false; });

  it('a second Enter while the send is pending opens no second print window and sends nothing more', async () => {
    const settle = pendingSend();
    const view = showPlan();
    const input = view.container.querySelector('#guestEmail') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a@example.com' } });
    enter(input);
    await waitFor(() => expect(mocks.sendGuestReport).toHaveBeenCalledTimes(1));
    expect(box(input).getByRole('button', { name: 'Sending...' })).toBeTruthy();
    enter(input);
    enter(input);
    await new Promise((r) => setTimeout(r, 20));
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(print).toHaveBeenCalledTimes(1);
    expect(mocks.sendGuestReport).toHaveBeenCalledTimes(1);
    settle({ success: true });
    await waitFor(() => expect(view.container.querySelector('#guestEmail')).toBeNull());
    expect(mocks.markReportEmailCaptured).toHaveBeenCalledTimes(1);
    expect(mocks.trackABConversion).toHaveBeenCalledTimes(1);
  });

  it('Enter then a click in the same moment still sends once', async () => {
    const settle = pendingSend();
    const view = showPlan();
    const input = view.container.querySelector('#guestEmail') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a@example.com' } });
    const btn = box(input).getByRole('button');
    // One act, no re-render between them: the button is not yet disabled.
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(mocks.sendGuestReport).toHaveBeenCalledTimes(1);
    settle({ success: true });
    await waitFor(() => expect(mocks.markReportEmailCaptured).toHaveBeenCalledTimes(1));
  });

  it('after a failed send the box works again', async () => {
    const settle = pendingSend();
    const view = showPlan();
    const input = view.container.querySelector('#guestEmail') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a@example.com' } });
    enter(input);
    await waitFor(() => expect(mocks.sendGuestReport).toHaveBeenCalledTimes(1));
    settle({ success: false, error: 'Too many requests' });
    await waitFor(() => expect(box(input).getByText('Too many requests')).toBeTruthy());
    mocks.sendGuestReport.mockResolvedValue({ success: true });
    enter(view.container.querySelector('#guestEmail') as HTMLInputElement);
    await waitFor(() => expect(mocks.sendGuestReport).toHaveBeenCalledTimes(2));
    expect(window.open).toHaveBeenCalledTimes(2);
  });

  it('the guard holds when the box moves mid-send (the full form opening)', async () => {
    const settle = pendingSend();
    const view = render(<MovingPdfHost inForm={false}/>);
    const first = view.container.querySelector('#guestEmail') as HTMLInputElement;
    fireEvent.change(first, { target: { value: 'a@example.com' } });
    enter(first);
    await waitFor(() => expect(mocks.sendGuestReport).toHaveBeenCalledTimes(1));
    view.rerender(<MovingPdfHost inForm/>);
    const moved = view.container.querySelector('.in-form #guestEmail') as HTMLInputElement;
    expect(moved).not.toBe(first);
    expect(moved.value).toBe('a@example.com');
    enter(moved);
    await new Promise((r) => setTimeout(r, 20));
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(mocks.sendGuestReport).toHaveBeenCalledTimes(1);
    settle({ success: true });
    await waitFor(() => expect(view.container.querySelector('#guestEmail')).toBeNull());
    expect(mocks.markReportEmailCaptured).toHaveBeenCalledTimes(1);
  });

  it('an invalid address while nothing is pending still says so and sends nothing', () => {
    const view = showPlan();
    const input = view.container.querySelector('#guestEmail') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'not-an-email' } });
    enter(input);
    expect(box(input).getByText('Please enter a valid email address')).toBeTruthy();
    expect(mocks.sendGuestReport).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });
});

describe('US-18 AC7 on the reminders box (US-44 AC3)', () => {
  it('a second Enter while the enrolment is pending sends nothing more', async () => {
    const settle = pendingSend();
    const view = showPlan();
    const input = view.container.querySelector('#reminderEmail') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a@example.com' } });
    enter(input);
    await waitFor(() => expect(mocks.sendGuestReport).toHaveBeenCalledTimes(1));
    enter(input);
    await new Promise((r) => setTimeout(r, 20));
    expect(mocks.sendGuestReport).toHaveBeenCalledTimes(1);
    expect(window.open).not.toHaveBeenCalled();
    settle({ success: true });
    await waitFor(() => expect(view.getAllByText(REMINDER_SIGNUP_DONE).length).toBeGreaterThan(0));
    expect(mocks.markReportEmailCaptured).toHaveBeenCalledTimes(1);
  });
});
