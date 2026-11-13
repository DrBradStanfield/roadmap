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
import { statTiles } from '@roadmap/health-core/stat-tiles';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
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
import { PlanHost as ResultsPanel } from '../testing/plan-host';
import { REMINDER_SIGNUP_LABEL, REMINDER_SIGNUP_DONE, GUEST_CAPTURE_BUTTON_LABEL, PDF_WINDOW_BLOCKED } from './PlanPdf';
import { deleteButton } from '../testing/settings';
import { ColumnHeader } from './ColumnHeader';
import { cascaded, nest } from '../testing/css-cascade';

const results = calculateHealthResults({ heightCm: 175, sex: 'male' });

function plan(props: Partial<React.ComponentProps<typeof ResultsPanel>> = {}) {
  return (
    <ResultsPanel results={results} isValid tiles={results ? statTiles(results, { unitSystem: 'si' }) : []} showEmailCapture formStage={3} {...props} />
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
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); });

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

// Brad 2026-11-10 ("drop the wait"): the window opens inside the click, so a slow
// save cannot let a popup blocker refuse it. The fields are still saved (US-03 AC3).
describe('US-08 — Save as PDF saves the typed values without waiting for the save', () => {
  it('a save that never resolves: the print window still opens, and the save was called once', async () => {
    const onSaveLongitudinal = vi.fn(() => new Promise<unknown>(() => {}));
    const view = showPlan({ hasUnsavedLongitudinal: true, onSaveLongitudinal });
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(onSaveLongitudinal).toHaveBeenCalledOnce();
  });
});

describe('US-44 AC3/AC4 — the optional reminders line', () => {
  it('renders once, labelled, with no mailing-list notice (Brad 2026-11-02) and no storage sentence (US-09 AC5)', () => {
    const view = showPlan();
    const inputs = view.container.querySelectorAll('input[type="email"]');
    expect(inputs).toHaveLength(1);
    expect(view.getByLabelText(REMINDER_SIGNUP_LABEL)).toBe(inputs[0]);
    const box = inputs[0].closest('.email-capture')!;
    expect(box.classList.contains('field-attention')).toBe(false);
    expect(box.querySelector('.email-capture-disclosure')).toBeNull();
    expect(box.textContent).not.toContain('MicroVitamin mailing list');
    expect(box.querySelector('.hr-storage-notice')).toBeNull();
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
  // One capture box since US-62 phase 5: My health's foot (the plan's top copy went with its column).
  it('keeps the email gate: no Save as PDF, one capture box, no reminders label', () => {
    mocks.skip.value = false;
    const view = showPlan();
    expect(view.queryByRole('button', { name: 'Save as PDF' })).toBeNull();
    expect(view.getAllByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })).toHaveLength(1);
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
    expect(note.closest('.report-actions')).toBe(view.getByRole('button', { name: 'Save as PDF' }).closest('.report-actions'));
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

  // One Save as PDF since US-62 phase 5, in My health's foot (the plan header went with its column).
  it('Pages build: the note sits beside the one Save as PDF button', async () => {
    mocks.shopify.value = false;
    refuseWindow();
    const view = showPlan({ showEmailCapture: false });
    const buttons = view.getAllByRole('button', { name: 'Save as PDF' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    await waitFor(() => expect(view.getByText(BLOCKED)).toBeTruthy());
    expect(view.getByText(BLOCKED).closest('.report-actions')).toBe(buttons[0].closest('.report-actions'));
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
  // US-62 AC26, AC30d: it sits in My health's PDF box, in the page's flow on phone and desktop
  // alike, so no column header has to keep it visible.
  it('Save as PDF sits in the PDF box, captured or gate skipped', () => {
    const view = showPlan();
    expect(view.getByRole('button', { name: 'Save as PDF' }).closest('.mh-pdf')).not.toBeNull();
  });

  it('gated and not yet captured, no Save as PDF until the capture, then it shows in the PDF box', async () => {
    mocks.skip.value = false;
    const view = showPlan();
    expect(view.queryByRole('button', { name: 'Save as PDF' })).toBeNull();
    fireEvent.change(view.container.querySelector('#guestEmail')!, { target: { value: 'reader@example.com' } });
    fireEvent.click(view.getAllByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })[0]);
    await waitFor(() => expect(view.getByRole('button', { name: 'Save as PDF' }).closest('.mh-pdf')).not.toBeNull());
  });

  // The chat column's header still hides on a phone; the plan header's actions rule went with the plan column.
  it('styles.css: at 768px the column header hides', () => {
    const header = render(<ColumnHeader title="Ask about your plan"/>).container.querySelector('.hr-col-header')!;
    for (const phone of [390, 768]) expect(cascaded(header, 'display', phone)).toBe('none');
    expect(cascaded(header, 'display', 769)).toBe('flex');
  });

  it('styles.css: a phone card sets no side margin; the tab panel gives its 16px inset (US-62 AC36)', () => {
    const card = nest('section-card');
    for (const side of ['margin-left', 'margin-right']) {
      for (const width of [390, 768, 769]) expect(cascaded(card, side, width)).toBeUndefined();
    }
    for (const side of ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']) {
      for (const phone of [390, 768]) {
        expect(cascaded(card, side, phone)).toBe('12px');
        // !important: the later .section-card--bt { padding: 0 } does not take a phone card's padding.
        expect(cascaded(nest('section-card section-card--bt'), side, phone)).toBe('12px');
      }
      expect(cascaded(card, side, 769)).toBe('24px'); // a desktop card keeps its 24px
    }
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

// US-09 AC19: the plan tells the storage button to pulse once the guest has
// their PDF: the record captured (gated page, this or a later visit), or on a
// gate-skipped page a Save as PDF whose window opened in this tab. Never before,
// so it never competes with the email box.
describe('US-09 AC19 — the storage button\'s attention flag', () => {
  const syncControl = ({ hasData, attention }: { hasData: boolean; attention: boolean }) =>
    hasData ? <span data-testid="sync">{String(attention)}</span> : null;
  const attention = (view: ReturnType<typeof showPlan>) => view.getByTestId('sync').textContent;
  const fillAndCapture = (view: ReturnType<typeof showPlan>) => {
    fireEvent.change(view.container.querySelector('#guestEmail')!, { target: { value: 'reader@example.com' } });
    fireEvent.click(view.getAllByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })[0]);
  };

  it('gated: off before capture and while sending, on once captured', async () => {
    mocks.skip.value = false;
    let send!: (r: { success: boolean }) => void;
    mocks.sendGuestReport.mockReturnValue(new Promise((r) => { send = r; }));
    const view = showPlan({ syncControl });
    expect(attention(view)).toBe('false');
    fillAndCapture(view);
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(attention(view)).toBe('false'); // the window opened, but the capture is still sending
    send({ success: true });
    await waitFor(() => expect(attention(view)).toBe('true'));
  });

  it('gated: a capture that fails to send stays off', async () => {
    mocks.skip.value = false;
    mocks.sendGuestReport.mockResolvedValue({ success: false, error: 'Please retry' });
    const view = showPlan({ syncControl });
    fillAndCapture(view);
    await waitFor(() => expect(view.getAllByText('Please retry').length).toBeGreaterThan(0));
    expect(attention(view)).toBe('false');
  });

  it('a later visit to a captured record is on from the start', () => {
    mocks.skip.value = false;
    mocks.getReportEmailCaptured.mockReturnValue(true);
    expect(attention(showPlan({ syncControl }))).toBe('true');
  });

  it('skip-gate: off until a Save as PDF window opens; a refused window keeps it off', async () => {
    vi.mocked(window.open).mockImplementation(() => null);
    const view = showPlan({ syncControl });
    expect(attention(view)).toBe('false');
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(view.getByText(PDF_WINDOW_BLOCKED)).toBeTruthy());
    expect(attention(view)).toBe('false');
    vi.mocked(window.open).mockImplementation(() => ({ document: { write: vi.fn(), close: vi.fn() }, print }) as unknown as Window);
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(attention(view)).toBe('true'));
  });

  it('skip-gate: a successful reminders sign-up turns it on (the record is captured), a failed one does not', async () => {
    mocks.sendGuestReport.mockResolvedValueOnce({ success: false, error: 'Please retry' });
    const view = showPlan({ syncControl });
    fireEvent.change(view.getByLabelText(REMINDER_SIGNUP_LABEL), { target: { value: 'reader@example.com' } });
    fireEvent.click(view.getByRole('button', { name: 'Remind me' }));
    await waitFor(() => expect(view.getByText('Please retry')).toBeTruthy());
    expect(attention(view)).toBe('false');
    fireEvent.click(view.getByRole('button', { name: 'Remind me' }));
    await waitFor(() => expect(view.getByText(REMINDER_SIGNUP_DONE)).toBeTruthy());
    expect(print).not.toHaveBeenCalled();
    expect(attention(view)).toBe('true');
  });

  it('skip-gate: an erase forgets the opened window; a cancelled one does not', async () => {
    const onDeleteData = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const view = showPlan({ syncControl, onDeleteData });
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(attention(view)).toBe('true'));
    fireEvent.click(deleteButton());
    await waitFor(() => expect(onDeleteData).toHaveBeenCalledTimes(1));
    expect(attention(view)).toBe('true');
    fireEvent.click(deleteButton());
    await waitFor(() => expect(attention(view)).toBe('false'));
  });

  // Another device's erase once re-read, or this tab's erase whose write failed
  // but still moved the erase (useErase.test.tsx): the screen shows a new erase
  // without a successful Delete here. Before, the pulse outlived it.
  it('skip-gate: any erase the screen shows forgets the opened window, not only a successful Delete here', async () => {
    const view = showPlan({ syncControl, shownErase: 'e1' });
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(attention(view)).toBe('true'));
    view.rerender(plan({ syncControl, shownErase: 'e1' }));
    expect(attention(view)).toBe('true');
    view.rerender(plan({ syncControl, shownErase: 'e2' }));
    expect(attention(view)).toBe('false');
  });

  // Brad 2026-11-10 (P3): the capture belongs to the erased record, so an erase resets it.
  describe('an erase resets the email capture', () => {
    // The record is captured once marked; a successful Delete erases it.
    let eraseRecord: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
    beforeEach(() => {
      mocks.markReportEmailCaptured.mockImplementation(() => { mocks.getReportEmailCaptured.mockReturnValue(true); });
      eraseRecord = vi.fn<() => Promise<boolean>>(async () => { mocks.getReportEmailCaptured.mockReturnValue(false); return true; });
    });

    it('gated captured: a Delete brings the gate box back and stops the pulse', async () => {
      mocks.skip.value = false;
      const view = showPlan({ syncControl, onDeleteData: eraseRecord });
      fillAndCapture(view);
      await waitFor(() => expect(attention(view)).toBe('true'));
      expect(view.container.querySelector('#guestEmail')).toBeNull();
      fireEvent.click(deleteButton());
      await waitFor(() => expect(view.container.querySelector('#guestEmail')).toBeTruthy());
      expect(view.getByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })).toBeTruthy();
      expect(view.queryByRole('button', { name: 'Save as PDF' })).toBeNull();
      expect(attention(view)).toBe('false');
    });

    it('gated captured: another device\'s erase, re-read, does the same', async () => {
      mocks.skip.value = false;
      const view = showPlan({ syncControl, shownErase: 'e1' });
      fillAndCapture(view);
      await waitFor(() => expect(attention(view)).toBe('true'));
      mocks.getReportEmailCaptured.mockReturnValue(false);
      view.rerender(plan({ syncControl, shownErase: 'e2' }));
      expect(view.container.querySelector('#guestEmail')).toBeTruthy();
      expect(attention(view)).toBe('false');
    });

    it('skip-gate reminded: a Delete brings the reminders box back', async () => {
      const view = showPlan({ syncControl, onDeleteData: eraseRecord });
      fireEvent.change(view.getByLabelText(REMINDER_SIGNUP_LABEL), { target: { value: 'reader@example.com' } });
      fireEvent.click(view.getByRole('button', { name: 'Remind me' }));
      await waitFor(() => expect(view.getByText(REMINDER_SIGNUP_DONE)).toBeTruthy());
      expect(attention(view)).toBe('true');
      fireEvent.click(deleteButton());
      await waitFor(() => expect(view.getByLabelText(REMINDER_SIGNUP_LABEL)).toBeTruthy());
      expect(view.queryByText(REMINDER_SIGNUP_DONE)).toBeNull();
      expect((view.getByLabelText(REMINDER_SIGNUP_LABEL) as HTMLInputElement).value).toBe('');
      expect(attention(view)).toBe('false');
    });

    it('an erase empties a typed, unsent address and its error', async () => {
      mocks.skip.value = false;
      const view = showPlan({ syncControl, onDeleteData: eraseRecord });
      fireEvent.change(view.container.querySelector('#guestEmail')!, { target: { value: 'not-an-email' } });
      fireEvent.click(view.getByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL }));
      expect(view.getByText('Please enter a valid email address')).toBeTruthy();
      fireEvent.click(deleteButton());
      await waitFor(() => expect(eraseRecord).toHaveBeenCalledOnce());
      await waitFor(() => expect((view.container.querySelector('#guestEmail') as HTMLInputElement).value).toBe(''));
      expect(view.queryByText('Please enter a valid email address')).toBeNull();
    });

    // US-09 AC19 + US-18 AC7: a send still pending at the erase belongs to the erased
    // record. The fresh box sends at once, and the old send's answer changes nothing in the box
    // on screen (the file's captured mark is H13's, a separate PR).
    describe('a send pending at the erase', () => {
      let settles: ((r: { success: boolean; error?: string }) => void)[];
      beforeEach(() => {
        mocks.skip.value = false;
        settles = [];
        mocks.sendGuestReport.mockImplementation(() => new Promise((r) => { settles.push(r); }));
      });
      const freshEnter = (view: ReturnType<typeof showPlan>, address: string) => {
        const input = view.container.querySelector('#guestEmail')!;
        fireEvent.change(input, { target: { value: address } });
        fireEvent.keyDown(input, { key: 'Enter' });
      };

      it('pending send, then a Delete: the fresh box\'s Enter sends, and its window opens', async () => {
        const view = showPlan({ syncControl, onDeleteData: eraseRecord });
        fillAndCapture(view);
        await waitFor(() => expect(mocks.sendGuestReport).toHaveBeenCalledTimes(1));
        expect(print).toHaveBeenCalledOnce();
        fireEvent.click(deleteButton());
        await waitFor(() => expect(view.getByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })).toBeTruthy());
        freshEnter(view, 'next@example.com');
        await waitFor(() => expect(mocks.sendGuestReport).toHaveBeenCalledTimes(2));
        expect(mocks.sendGuestReport).toHaveBeenLastCalledWith('next@example.com');
        expect(print).toHaveBeenCalledTimes(2);
      });

      it('pending send, then another device\'s erase: the old send succeeding leaves the new box and no pulse', async () => {
        const view = showPlan({ syncControl, shownErase: 'e1' });
        fillAndCapture(view);
        await waitFor(() => expect(mocks.sendGuestReport).toHaveBeenCalledTimes(1));
        view.rerender(plan({ syncControl, shownErase: 'e2' }));
        await act(async () => { settles[0]({ success: true }); });
        expect(view.container.querySelector('#guestEmail')).toBeTruthy();
        expect(view.getByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })).toBeTruthy();
        expect(view.queryByRole('button', { name: 'Save as PDF' })).toBeNull();
        expect(attention(view)).toBe('false');
      });

      it('pending send, Delete, a new send: the old send failing shows no error and keeps the new send', async () => {
        const view = showPlan({ syncControl, onDeleteData: eraseRecord });
        fillAndCapture(view);
        await waitFor(() => expect(mocks.sendGuestReport).toHaveBeenCalledTimes(1));
        fireEvent.click(deleteButton());
        await waitFor(() => expect(view.getByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })).toBeTruthy());
        freshEnter(view, 'next@example.com');
        await waitFor(() => expect(mocks.sendGuestReport).toHaveBeenCalledTimes(2));
        await act(async () => { settles[0]({ success: false, error: 'Old send failed' }); });
        expect(view.queryByText('Old send failed')).toBeNull();
        expect(view.getByRole('button', { name: 'Sending...' })).toBeTruthy();
        await act(async () => { settles[1]({ success: true }); });
        expect(view.queryByRole('button', { name: 'Save as PDF' })).toBeTruthy();
        expect(attention(view)).toBe('true');
      });
    });

    it('a cancelled erase keeps the captured view, the pulse and a typed address', async () => {
      mocks.skip.value = false;
      const cancel = vi.fn().mockResolvedValue(false);
      const view = showPlan({ syncControl, onDeleteData: cancel });
      fireEvent.change(view.container.querySelector('#guestEmail')!, { target: { value: 'half-typed' } });
      fireEvent.click(deleteButton());
      await waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
      expect((view.container.querySelector('#guestEmail') as HTMLInputElement).value).toBe('half-typed');
      fillAndCapture(view);
      await waitFor(() => expect(attention(view)).toBe('true'));
      fireEvent.click(deleteButton());
      await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));
      expect(view.container.querySelector('#guestEmail')).toBeNull();
      expect(attention(view)).toBe('true');
    });
  });

  it('skip-gate: a plan that goes blank mid-edit (height cleared) keeps it on', async () => {
    const view = showPlan({ syncControl });
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(attention(view)).toBe('true'));
    view.rerender(plan({ syncControl, results: null, isValid: false }));
    view.rerender(plan({ syncControl }));
    expect(attention(view)).toBe('true');
  });

  it('Pages never pulses, even with a captured record or an opened PDF window', async () => {
    mocks.shopify.value = false;
    mocks.skip.value = false;
    mocks.getReportEmailCaptured.mockReturnValue(true);
    const view = showPlan({ syncControl, showEmailCapture: false });
    expect(attention(view)).toBe('false');
    fireEvent.click(view.getAllByRole('button', { name: 'Save as PDF' })[0]);
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(attention(view)).toBe('false');
  });
});

// US-07 AC6 (amended 2026-10-14): a known minor is never asked for an email.
// Both boxes subscribe the address to the MicroVitamin list, so neither shows.
// The plan's PDF stays theirs: the gate-skipped page's Save as PDF (US-44 AC2),
// on every page.
describe('US-07 AC6 — a known minor gets Save as PDF and no email box', () => {
  // Ten years old on any clock.
  const minor = calculateHealthResults({ heightCm: 150, sex: 'female', weightKg: 45, birthYear: new Date().getFullYear() - 10 });

  it.each([['gated', false], ['gate-skipped', true]] as const)('on the %s page: no email box, no mailing-list line', (_, skip) => {
    mocks.skip.value = skip;
    const view = showPlan({ results: minor });
    expect(view.container.querySelector('input[type="email"]')).toBeNull();
    expect(view.container.querySelector('.email-capture')).toBeNull();
    expect(view.container.textContent).not.toContain('MicroVitamin mailing list');
    expect(view.queryByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL })).toBeNull();
  });

  it('on the gated page, Save as PDF opens the print window and sends no email anywhere', async () => {
    mocks.skip.value = false;
    const view = showPlan({ results: minor });
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(print).toHaveBeenCalledOnce());
    expect(mocks.sendGuestReport).not.toHaveBeenCalled();
    expect(mocks.markReportEmailCaptured).not.toHaveBeenCalled();
  });

  // US-09 AC19: their PDF from the header turns on the storage button's pulse,
  // as a Save as PDF does on the gate-skipped page.
  it('on the gated page, a Save as PDF whose window opened turns on the storage pulse', async () => {
    mocks.skip.value = false;
    const syncControl = ({ hasData, attention }: { hasData: boolean; attention: boolean }) =>
      hasData ? <span data-testid="sync">{String(attention)}</span> : null;
    const view = showPlan({ results: minor, syncControl });
    expect(view.getByTestId('sync').textContent).toBe('false');
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(view.getByTestId('sync').textContent).toBe('true'));
  });

  it('an adult on the gated page still gets the email box', () => {
    mocks.skip.value = false;
    const view = showPlan();
    expect(view.getAllByRole('button', { name: GUEST_CAPTURE_BUTTON_LABEL }).length).toBeGreaterThan(0);
  });
});

