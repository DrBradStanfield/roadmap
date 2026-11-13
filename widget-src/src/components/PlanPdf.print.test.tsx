// @vitest-environment jsdom
/**
 * Save as PDF's print state as the screen shows it (US-18 AC6, US-09 AC19): idle,
 * preparing, a refused window, an opened window, and the capture's send after a
 * refused window (lead P8). Pinned on main before the four flags became one state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { statTiles } from '@roadmap/health-core/stat-tiles';
import { calculateHealthResults } from '@roadmap/health-core/calculations';

const mocks = vi.hoisted(() => ({
  getReportHtml: vi.fn(),
  sendGuestReport: vi.fn(),
  getReportEmailCaptured: vi.fn(),
  trackProductEvent: vi.fn(),
  skip: { value: true },
}));
vi.mock('../lib/roadmap-data', () => ({
  getReportHtml: mocks.getReportHtml,
  sendGuestReport: mocks.sendGuestReport,
  getReportEmailCaptured: mocks.getReportEmailCaptured,
  markReportEmailCaptured: vi.fn(),
  getShownErase: () => 'erase-1',
}));
vi.mock('../lib/server-api', () => ({ trackABConversion: vi.fn(), trackProductEvent: mocks.trackProductEvent }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: true }));
vi.mock('../lib/assistant-config', () => ({ getSkipEmailGate: () => mocks.skip.value }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
import { PlanHost } from '../testing/plan-host';
import { GUEST_CAPTURE_BUTTON_LABEL, PDF_WINDOW_BLOCKED } from './PlanPdf';

const results = calculateHealthResults({ heightCm: 175, sex: 'male' });
const syncControl = ({ hasData, attention }: { hasData: boolean; attention: boolean }) =>
  hasData ? <span data-testid="sync">{String(attention)}</span> : null;
const showPlan = () => render(
  <PlanHost results={results} isValid tiles={results ? statTiles(results, { unitSystem: 'si' }) : []} showEmailCapture formStage={3} syncControl={syncControl}/>,
);
type View = ReturnType<typeof showPlan>;
const pulse = (view: View) => view.getByTestId('sync').textContent;
const saveButton = (view: View) => view.container.querySelector('.report-actions button') as HTMLButtonElement;
const note = (view: View) => view.container.querySelectorAll('.hr-pdf-blocked');
const report = (view: View) => view.container.querySelector('.hr-report');
const openWindow = () => vi.mocked(window.open).mockImplementation(() => ({ document: { write: vi.fn(), close: vi.fn() }, print: vi.fn() }) as unknown as Window);
const refuseWindow = () => vi.mocked(window.open).mockImplementation(() => null);

/** getReportHtml held open; it records whether the hidden report was drawn when it copied. */
function heldReport() {
  let finish: () => void = () => {};
  const drawnAtCopy: boolean[] = [];
  mocks.getReportHtml.mockImplementation(() => {
    drawnAtCopy.push(!!document.querySelector('.hr-report'));
    return new Promise((r) => { finish = () => r({ success: true, html: '<p>Local report</p>' }); });
  });
  return { finish: () => finish(), drawnAtCopy };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.skip.value = true;
  mocks.getReportEmailCaptured.mockReturnValue(false);
  mocks.getReportHtml.mockResolvedValue({ success: true, html: '<p>Local report</p>' });
  mocks.sendGuestReport.mockResolvedValue({ success: true });
  vi.spyOn(window, 'open');
  openWindow();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('US-18 AC6: what Save as PDF shows in each print state', () => {
  it('idle: Save as PDF, enabled, an empty note, no hidden report, no pulse', () => {
    const view = showPlan();
    expect(saveButton(view).textContent).toBe('Save as PDF');
    expect(saveButton(view).disabled).toBe(false);
    expect([...note(view)].map((n) => n.textContent)).toEqual(['']);
    expect(report(view)).toBeNull();
    expect(pulse(view)).toBe('false');
  });

  it('preparing: Loading..., disabled, the report drawn while copied and gone after; a second press does nothing', async () => {
    const held = heldReport();
    const view = showPlan();
    fireEvent.click(saveButton(view));
    expect(held.drawnAtCopy).toEqual([true]);
    expect(saveButton(view).textContent).toBe('Loading...');
    expect(saveButton(view).disabled).toBe(true);
    expect(report(view)).toBeNull();
    fireEvent.click(saveButton(view));
    expect(mocks.getReportHtml).toHaveBeenCalledOnce();
    held.finish();
    await waitFor(() => expect(saveButton(view).textContent).toBe('Save as PDF'));
    expect(window.open).toHaveBeenCalledOnce();
  });

  it('a refused window: the note beside the button, the button back, no pulse', async () => {
    refuseWindow();
    const view = showPlan();
    fireEvent.click(saveButton(view));
    await waitFor(() => expect(note(view)[0].textContent).toBe(PDF_WINDOW_BLOCKED));
    expect(saveButton(view).textContent).toBe('Save as PDF');
    expect(saveButton(view).disabled).toBe(false);
    expect(pulse(view)).toBe('false');
    expect(mocks.trackProductEvent).toHaveBeenCalledWith('pdf_window_blocked');
  });

  it('opened: no note, the button back, and the pulse stays on after a later refusal', async () => {
    const view = showPlan();
    fireEvent.click(saveButton(view));
    await waitFor(() => expect(pulse(view)).toBe('true'));
    expect(note(view)[0].textContent).toBe('');
    expect(saveButton(view).textContent).toBe('Save as PDF');
    refuseWindow();
    fireEvent.click(saveButton(view));
    await waitFor(() => expect(note(view)[0].textContent).toBe(PDF_WINDOW_BLOCKED));
    expect(pulse(view)).toBe('true');
  });
});

describe('US-18 AC6 (lead P8): the capture\'s send after a refused window', () => {
  beforeEach(() => { mocks.skip.value = false; });

  it('while the send runs, the box says Sending... and that the window did not open', async () => {
    refuseWindow();
    let settle: (r: { success: boolean }) => void = () => {};
    mocks.sendGuestReport.mockImplementation(() => new Promise((r) => { settle = r; }));
    const view = showPlan();
    const input = view.container.querySelector('#guestEmail')!;
    fireEvent.change(input, { target: { value: 'reader@example.com' } });
    fireEvent.click(view.getByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL }));
    await waitFor(() => expect(mocks.sendGuestReport).toHaveBeenCalledOnce());
    const box = input.closest('.email-capture')!;
    expect(box.querySelector('button')!.textContent).toBe('Sending...');
    await waitFor(() => expect(box.querySelector('.hr-pdf-blocked')!.textContent).toBe(PDF_WINDOW_BLOCKED));
    settle({ success: true });
    await waitFor(() => expect(view.container.querySelector('#guestEmail')).toBeNull());
    expect(note(view)[0].textContent).toBe(PDF_WINDOW_BLOCKED);
  });

  it('a send after an opened window shows no note', async () => {
    let settle: (r: { success: boolean }) => void = () => {};
    mocks.sendGuestReport.mockImplementation(() => new Promise((r) => { settle = r; }));
    const view = showPlan();
    const input = view.container.querySelector('#guestEmail')!;
    fireEvent.change(input, { target: { value: 'reader@example.com' } });
    fireEvent.click(view.getByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL }));
    await waitFor(() => expect(mocks.sendGuestReport).toHaveBeenCalledOnce());
    const box = input.closest('.email-capture')!;
    expect(box.querySelector('button')!.textContent).toBe('Sending...');
    expect(box.querySelector('.hr-pdf-blocked')!.textContent).toBe('');
    settle({ success: true });
    await waitFor(() => expect(view.container.querySelector('#guestEmail')).toBeNull());
  });
});
