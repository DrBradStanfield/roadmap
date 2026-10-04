// @vitest-environment jsdom
/**
 * US-44 — the funnel page (/pages/start) skips the email gate before
 * "Save as PDF". The block's `skip_email_gate` setting reaches the widget as
 * `data-skip-email-gate`. The setting is never written to the user's record;
 * only a successful reminders sign-up marks it captured (AC3).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { calculateHealthResults } from '@roadmap/health-core';

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
}));
vi.mock('../lib/server-api', () => ({ trackABConversion: mocks.trackABConversion, trackProductEvent: mocks.trackProductEvent }));
vi.mock('../lib/build-flags', () => ({ get SHOPIFY_SURFACE() { return mocks.shopify.value; } }));
vi.mock('../lib/assistant-config', () => ({ getSkipEmailGate: () => mocks.skip.value }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
import { ResultsPanel, REMINDER_SIGNUP_LABEL, REMINDER_SIGNUP_DONE, GUEST_CAPTURE_BUTTON_LABEL, PDF_WINDOW_BLOCKED } from './ResultsPanel';
import { EMAIL_STORAGE_NOTICE, StorageNoticeContext } from '../lib/storage-notice';

const results = calculateHealthResults({ heightCm: 175, sex: 'male' });

function plan(props: Partial<React.ComponentProps<typeof ResultsPanel>> = {}) {
  return (
    <StorageNoticeContext.Provider value>
      <ResultsPanel results={results} isValid unitSystem="si" showEmailCapture formStage={3} {...props} />
    </StorageNoticeContext.Provider>
  );
}
function showPlan(props: Partial<React.ComponentProps<typeof ResultsPanel>> = {}) {
  return render(plan(props));
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
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('US-44 AC2 — gate skipped: Save as PDF straight away, nothing persisted', () => {
  it('shows Save as PDF on first render, with no gating email box and no write to the record', () => {
    const view = showPlan();
    expect(view.getByRole('button', { name: 'Save as PDF' })).toBeTruthy();
    expect(view.queryByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })).toBeNull();
    expect(view.container.querySelector('#guestEmail')).toBeNull();
    expect(mocks.markReportEmailCaptured).not.toHaveBeenCalled();
    expect(mocks.sendGuestReport).not.toHaveBeenCalled();
  });

  it('Save as PDF opens the print window without any email', async () => {
    const view = showPlan();
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(mocks.sendGuestReport).not.toHaveBeenCalled();
    expect(mocks.markReportEmailCaptured).not.toHaveBeenCalled();
  });
});

describe('US-44 AC3/AC4 — the optional reminders line', () => {
  it('renders once, labelled, with the MicroVitamin list disclosure and the storage sentence last', () => {
    const view = showPlan();
    const inputs = view.container.querySelectorAll('input[type="email"]');
    expect(inputs).toHaveLength(1);
    expect(view.getByLabelText(REMINDER_SIGNUP_LABEL)).toBe(inputs[0]);
    const box = inputs[0].closest('.email-capture')!;
    expect(box.classList.contains('field-attention')).toBe(false);
    const disclosure = box.querySelector('.email-capture-disclosure')!;
    expect(disclosure.textContent).toBe(
      'Signing up adds you to the MicroVitamin mailing list (Dr Brad\'s supplement company), and ' +
        'we\'ll email you when a check-up or blood test is due. We store only check-up names and dates, ' +
        'never your results. Every email has a one-click unsubscribe.',
    );
    expect(disclosure.querySelector('strong')?.textContent).toBe('MicroVitamin mailing list');
    const notice = box.querySelector('.hr-storage-notice')!;
    expect(notice.textContent).toBe(EMAIL_STORAGE_NOTICE);
    expect(box.lastElementChild).toBe(notice);
  });

  it('submitting enrols through the same capture call, opens no print window and marks the record captured', async () => {
    const view = showPlan();
    fireEvent.change(view.getByLabelText(REMINDER_SIGNUP_LABEL), { target: { value: ' reader@example.com ' } });
    fireEvent.click(view.getByRole('button', { name: 'Remind me' }));
    await waitFor(() => expect(view.getByText(REMINDER_SIGNUP_DONE)).toBeTruthy());
    expect(mocks.sendGuestReport).toHaveBeenCalledOnce();
    expect(mocks.sendGuestReport).toHaveBeenCalledWith('reader@example.com');
    expect(print).not.toHaveBeenCalled();
    expect(mocks.markReportEmailCaptured).toHaveBeenCalledOnce();
    expect(mocks.trackABConversion).not.toHaveBeenCalled();
    expect(view.getByRole('button', { name: 'Save as PDF' })).toBeTruthy();
    expect(view.container.querySelector('input[type="email"]')).toBeNull();
  });

  it('rejects a bad address without calling the server', () => {
    const view = showPlan();
    fireEvent.change(view.getByLabelText(REMINDER_SIGNUP_LABEL), { target: { value: 'not-an-email' } });
    fireEvent.click(view.getByRole('button', { name: 'Remind me' }));
    expect(view.getByText('Please enter a valid email address')).toBeTruthy();
    expect(mocks.sendGuestReport).not.toHaveBeenCalled();
  });

  it('a failed enrolment keeps the field and the error, and still persists nothing', async () => {
    mocks.sendGuestReport.mockResolvedValue({ success: false, error: 'Please retry' });
    const view = showPlan();
    fireEvent.change(view.getByLabelText(REMINDER_SIGNUP_LABEL), { target: { value: 'reader@example.com' } });
    fireEvent.click(view.getByRole('button', { name: 'Remind me' }));
    await waitFor(() => expect(view.getByText('Please retry')).toBeTruthy());
    expect(view.getByLabelText(REMINDER_SIGNUP_LABEL)).toBeTruthy();
    expect(view.getByRole('button', { name: 'Save as PDF' })).toBeTruthy();
    expect(mocks.markReportEmailCaptured).not.toHaveBeenCalled();
  });

  it('after a successful sign-up, the next render shows the captured view', async () => {
    mocks.markReportEmailCaptured.mockImplementation(() => { mocks.getReportEmailCaptured.mockReturnValue(true); });
    const first = showPlan();
    fireEvent.change(first.getByLabelText(REMINDER_SIGNUP_LABEL), { target: { value: 'reader@example.com' } });
    fireEvent.click(first.getByRole('button', { name: 'Remind me' }));
    await waitFor(() => expect(first.getByText(REMINDER_SIGNUP_DONE)).toBeTruthy());
    first.unmount();
    const again = showPlan();
    expect(again.container.querySelector('input[type="email"]')).toBeNull();
    expect(again.getByRole('button', { name: 'Save as PDF' })).toBeTruthy();
  });

  it('a returning visitor who already captured sees today\'s captured view (no box)', () => {
    mocks.getReportEmailCaptured.mockReturnValue(true);
    const view = showPlan();
    expect(view.getByRole('button', { name: 'Save as PDF' })).toBeTruthy();
    expect(view.container.querySelector('input[type="email"]')).toBeNull();
  });
});

describe('US-44 AC5 — gate not skipped: today\'s behaviour', () => {
  it('keeps the email gate: no Save as PDF, two capture boxes, no reminders label', () => {
    mocks.skip.value = false;
    const view = showPlan();
    expect(view.queryByRole('button', { name: 'Save as PDF' })).toBeNull();
    expect(view.getAllByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })).toHaveLength(2);
    expect(view.container.querySelector('#guestEmail')).toBeTruthy();
    expect(view.queryByText(REMINDER_SIGNUP_LABEL)).toBeNull();
  });

  it('capture still prints first and marks the record captured', async () => {
    mocks.skip.value = false;
    const view = showPlan();
    fireEvent.change(view.container.querySelector('#guestEmail')!, { target: { value: 'reader@example.com' } });
    fireEvent.click(view.getAllByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })[0]);
    await waitFor(() => expect(view.getByRole('button', { name: 'Save as PDF' })).toBeTruthy());
    expect(print).toHaveBeenCalledOnce();
    expect(mocks.markReportEmailCaptured).toHaveBeenCalledOnce();
  });
});

describe('US-18 AC6 — a refused print window is never silent', () => {
  // The words Brad signs. No em dash, no claim the plan is saved here (a device
  // that refused storage runs from memory), and never "use another browser":
  // that browser would not hold this plan.
  const BLOCKED = "The PDF window didn't open. Try Save as PDF again. Some apps' built-in browsers block it.";
  const opens = () => vi.mocked(window.open).mockImplementation(() => ({ document: { write: vi.fn(), close: vi.fn() }, print }) as unknown as Window);
  const refuseWindow = () => vi.mocked(window.open).mockImplementation(() => null);
  const blockedEvents = () => mocks.trackProductEvent.mock.calls.filter(([name]) => name === 'pdf_window_blocked');

  it('the copy is plain: no em dash, no other browser, no claim the plan is saved', () => {
    expect(PDF_WINDOW_BLOCKED).toBe(BLOCKED);
    expect(BLOCKED).not.toMatch(/\u2014/);
    expect(BLOCKED.toLowerCase()).not.toMatch(/saved|stored/);
    expect(BLOCKED.toLowerCase()).not.toMatch(/another browser|different browser|other browser/);
  });

  it('gated (/pages/roadmap): the capture still completes, and Save as PDF says the window did not open', async () => {
    mocks.skip.value = false;
    refuseWindow();
    const view = showPlan();
    fireEvent.change(view.container.querySelector('#guestEmail')!, { target: { value: 'reader@example.com' } });
    fireEvent.click(view.getAllByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })[0]);
    await waitFor(() => expect(view.getByRole('button', { name: 'Save as PDF' })).toBeTruthy());
    expect(window.open).toHaveBeenCalledOnce();
    expect(mocks.sendGuestReport).toHaveBeenCalledWith('reader@example.com');
    expect(mocks.markReportEmailCaptured).toHaveBeenCalledOnce();
    expect(mocks.trackABConversion).toHaveBeenCalledOnce();
    expect(view.container.querySelector('#guestEmail')).toBeNull();
    const note = view.getByText(BLOCKED);
    expect(note.getAttribute('role')).toBe('status');
    expect(note.closest('.hr-col-meta')).toBe(view.getByRole('button', { name: 'Save as PDF' }).closest('.hr-col-meta'));
    expect(blockedEvents()).toEqual([['pdf_window_blocked']]);
  });

  it('gated: a later Save as PDF whose window opens clears the message', async () => {
    mocks.skip.value = false;
    refuseWindow();
    const view = showPlan();
    fireEvent.change(view.container.querySelector('#guestEmail')!, { target: { value: 'reader@example.com' } });
    fireEvent.click(view.getAllByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })[0]);
    await waitFor(() => expect(view.getByText(BLOCKED)).toBeTruthy());
    vi.mocked(window.open).mockImplementation(() => ({ document: { write: vi.fn(), close: vi.fn() }, print }) as unknown as Window);
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    await waitFor(() => expect(view.queryByText(BLOCKED)).toBeNull());
  });

  it('skip-gate (/pages/start): the header Save as PDF says so when its own window is refused, and clears on success', async () => {
    refuseWindow();
    const view = showPlan();
    expect(view.queryByText(BLOCKED)).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(view.getByText(BLOCKED)).toBeTruthy());
    expect(blockedEvents()).toEqual([['pdf_window_blocked']]);
    expect(mocks.markReportEmailCaptured).not.toHaveBeenCalled();
    vi.mocked(window.open).mockImplementation(() => ({ document: { write: vi.fn(), close: vi.fn() }, print }) as unknown as Window);
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    await waitFor(() => expect(view.queryByText(BLOCKED)).toBeNull());
  });

  it('each refusal is announced again: the same live region empties, then refills', async () => {
    refuseWindow();
    const view = showPlan();
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    const note = await waitFor(() => view.getByText(BLOCKED));
    expect(note.getAttribute('role')).toBe('status');
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    expect(note.textContent).toBe('');
    await waitFor(() => expect(note.textContent).toBe(BLOCKED));
    expect(view.getByText(BLOCKED)).toBe(note);
    expect(blockedEvents()).toHaveLength(2); // trackProductEvent itself sends once per tab session
  });

  it('on a phone the Plan tab re-measures its height when the note comes and goes', async () => {
    const onLayoutChange = vi.fn();
    refuseWindow();
    const view = showPlan({ onLayoutChange });
    onLayoutChange.mockClear();
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(view.getByText(BLOCKED)).toBeTruthy());
    expect(onLayoutChange).toHaveBeenCalled();
    onLayoutChange.mockClear();
    opens();
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(view.queryByText(BLOCKED)).toBeNull());
    expect(onLayoutChange).toHaveBeenCalled();
    const tool = readFileSync(resolve(__dirname, 'HealthTool.tsx'), 'utf8');
    expect(tool).toContain('onLayoutChange: () => liveSwiper()?.updateAutoHeight(),');
  });

  it('a refusal on a capture that then fails to send shows beside that error', async () => {
    mocks.skip.value = false;
    mocks.sendGuestReport.mockResolvedValue({ success: false, error: 'Please retry' });
    refuseWindow();
    const view = showPlan();
    fireEvent.change(view.container.querySelector('#guestEmail')!, { target: { value: 'reader@example.com' } });
    fireEvent.click(view.getAllByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })[0]);
    await waitFor(() => expect(view.getAllByText('Please retry').length).toBeGreaterThan(0));
    const box = view.getAllByText('Please retry')[0].closest('.email-capture')!;
    expect(box.textContent).toContain(BLOCKED);
    expect(mocks.markReportEmailCaptured).not.toHaveBeenCalled();
    expect(blockedEvents()).toEqual([['pdf_window_blocked']]);
  });

  it('a capture whose report could not be built counts as a refusal', async () => {
    mocks.skip.value = false;
    mocks.getReportHtml.mockResolvedValue({ success: false, error: 'still loading' });
    const view = showPlan();
    fireEvent.change(view.container.querySelector('#guestEmail')!, { target: { value: 'reader@example.com' } });
    fireEvent.click(view.getAllByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })[0]);
    await waitFor(() => expect(view.getByRole('button', { name: 'Save as PDF' })).toBeTruthy());
    expect(window.open).not.toHaveBeenCalled();
    expect(mocks.markReportEmailCaptured).toHaveBeenCalledOnce();
    expect(view.getByText(BLOCKED)).toBeTruthy();
    expect(blockedEvents()).toEqual([['pdf_window_blocked']]);
  });

  it('Save as PDF whose report could not be built counts as a refusal', async () => {
    mocks.getReportHtml.mockResolvedValue({ success: false, error: 'still loading' });
    const view = showPlan();
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(view.getByText(BLOCKED)).toBeTruthy());
    expect(view.getByRole('button', { name: 'Save as PDF' })).toBeTruthy();
    expect(blockedEvents()).toEqual([['pdf_window_blocked']]);
  });

  it('an erase clears the note, so it does not come back with the next plan', async () => {
    refuseWindow();
    const view = showPlan();
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(view.getByText(BLOCKED)).toBeTruthy());
    view.rerender(plan({ results: null, isValid: false }));
    view.rerender(plan());
    expect(view.queryByText(BLOCKED)).toBeNull();
  });

  it('Pages build: the note sits beside the Save as PDF button pressed', async () => {
    mocks.shopify.value = false;
    refuseWindow();
    const view = showPlan({ showEmailCapture: false });
    const [header, bottom] = view.getAllByRole('button', { name: 'Save as PDF' });
    fireEvent.click(bottom);
    await waitFor(() => expect(view.getByText(BLOCKED)).toBeTruthy());
    expect(view.getByText(BLOCKED).closest('.report-actions')).toBe(bottom.closest('.report-actions'));
    expect(header.closest('.hr-col-meta')!.textContent).not.toContain(BLOCKED);
    fireEvent.click(header);
    await waitFor(() => expect(view.getByText(BLOCKED).closest('.hr-col-meta')).toBe(header.closest('.hr-col-meta')));
    expect(bottom.closest('.report-actions')!.textContent).not.toContain(BLOCKED);
  });

  it('a window that opens shows no message and fires no event', async () => {
    const view = showPlan();
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(view.queryByText(BLOCKED)).toBeNull();
    expect(blockedEvents()).toEqual([]);
  });
});

describe('US-44 AC6 — Save as PDF shows on a phone', () => {
  // jsdom applies no media queries, so this pins the class on the plan header
  // and the phone rule in styles.css that keeps that header's actions visible.
  const planHeader = (view: ReturnType<typeof showPlan>) => view.container.querySelector('.hr-col-header')!;

  it('the plan header carries the actions modifier when it holds Save as PDF', () => {
    const view = showPlan();
    expect(planHeader(view).contains(view.getByRole('button', { name: 'Save as PDF' }))).toBe(true);
    expect(planHeader(view).classList.contains('hr-col-header--actions')).toBe(true);
  });

  it('gated and not yet captured, the header holds no action, so no modifier (no empty row on a phone)', async () => {
    mocks.skip.value = false;
    const view = showPlan();
    expect(planHeader(view).classList.contains('hr-col-header--actions')).toBe(false);
    fireEvent.change(view.container.querySelector('#guestEmail')!, { target: { value: 'reader@example.com' } });
    fireEvent.click(view.getAllByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })[0]);
    await waitFor(() => expect(planHeader(view).classList.contains('hr-col-header--actions')).toBe(true));
  });

  it('the empty-plan placeholder header and the input header stay fully hidden on a phone', () => {
    const view = render(<ResultsPanel results={null} isValid={false} unitSystem="si" />);
    expect(planHeader(view as ReturnType<typeof showPlan>).classList.contains('hr-col-header--actions')).toBe(false);
    const input = readFileSync(resolve(__dirname, 'InputPanel.tsx'), 'utf8');
    const inputHeader = /<ColumnHeader step=\{1\}[^\n]*\/>/.exec(input)![0];
    expect(inputHeader).not.toContain('actions');
  });

  it('styles.css: at 768px the column header hides, except the plan header\'s actions', () => {
    const css = readFileSync(resolve(__dirname, '../styles.css'), 'utf8').replace(/\s+/g, ' ');
    const hide = css.indexOf('.hr-col-header { display: none; }');
    expect(hide).toBeGreaterThan(-1);
    const block = css.slice(css.lastIndexOf('@media (max-width: 768px) {', hide), css.indexOf('.hr-guide-mobile', hide));
    const keep = block.indexOf('.hr-col-header--actions { display: flex;');
    expect(keep).toBeGreaterThan(block.indexOf('.hr-col-header { display: none; }'));
    expect(block).toContain('.hr-col-header--actions .hr-col-title { display: none; }');
  });
});

describe('US-44 AC1 — the block setting', () => {
  const block = () => readFileSync(
    resolve(__dirname, '../../../extensions/health-tool-widget/blocks/app-block.liquid'),
    'utf8',
  );

  it('declares skip_email_gate as an unticked checkbox', () => {
    const schema = JSON.parse(/\{% schema %\}([\s\S]*?)\{% endschema %\}/.exec(block())![1]);
    const setting = schema.settings.find((x: { id: string }) => x.id === 'skip_email_gate');
    expect(setting).toMatchObject({ type: 'checkbox', default: false });
  });

  it('emits it on the tool root as data-skip-email-gate', () => {
    const rootTag = /<div\b[^>]*id="health-tool-root"[^>]*>/s.exec(block())![0];
    expect(rootTag).toContain('data-skip-email-gate="{{ block.settings.skip_email_gate }}"');
  });
});
