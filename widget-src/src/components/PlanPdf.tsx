// My health's PDF box (US-62 AC26, US-18, US-44): Save as PDF and the email capture
// beside it, the print state (usePlanPrint), and the two rules that read the capture:
// which box shows (pdfBox) and when the storage button pulses (storagePulse).
import React, { useState, useRef } from 'react';
import { flushSync } from 'react-dom';
import { getReportHtml, sendGuestReport, getReportEmailCaptured, markReportEmailCaptured, getShownErase } from '../lib/roadmap-data';
import { trackABConversion, trackProductEvent } from '../lib/server-api';
import { EMAIL_REGEX } from '../lib/email';
import { SHOPIFY_SURFACE } from '../lib/build-flags';
import { getSkipEmailGate } from '../lib/assistant-config';

// 'skipped' + 'reminded' are US-44's funnel-page states: the block skips the
// email gate, so the box only offers reminders; only a successful sign-up persists.
type GuestEmailState = 'idle' | 'sending' | 'captured' | 'skipped' | 'reminded';

// On local-first the capture button DELIVERS the plan by opening the browser
// save-as-PDF window; the email field only subscribes to Klaviyo (no plan is
// emailed). Copy reflects that (Brad, 2026-06-15) — no A/B helper variants on v2.
export const LOCAL_FIRST_EMAIL_HELPER = 'Get a PDF of your personalized plan, with detailed explanations and clinical references for every suggestion.';

/** Button label on the guest plan-capture CTA. On every live (LOCAL_FIRST)
 *  surface the click opens the browser save-as-PDF window, so the label is
 *  PDF-accurate (the email field only subscribes to Klaviyo). */
export const GUEST_CAPTURE_BUTTON_LABEL = 'Get My Health Plan';

/** US-44: the funnel page's optional reminders line (no email gate there). */
export const REMINDER_SIGNUP_LABEL = 'Email me when a check-up is due';
const REMINDER_SIGNUP_HELPER = "Optional. You don't need this to save your PDF.";
const REMINDER_SIGNUP_BUTTON = 'Remind me';
export const REMINDER_SIGNUP_DONE = "You're signed up. We'll email you when a check-up is due.";

/** US-18 AC6: shown beside the Save as PDF pressed when the browser refuses
 *  the print window. No claim the plan is saved here (a device that refused
 *  storage runs from memory), and never another browser: it would not hold
 *  this plan. */
export const PDF_WINDOW_BLOCKED = "The PDF window didn't open. Try Save as PDF again. Some apps' built-in browsers block it.";

/** The button whose print window was refused: the note sits beside it. */
type PdfButton = 'bottom' | 'capture';

/** US-18 AC6: always mounted and emptied before each try, so every refusal is announced. */
function PdfNote({ show }: { show: boolean }) {
  return <span className="hr-pdf-blocked no-print" role="status">{show ? PDF_WINDOW_BLOCKED : ''}</span>;
}

/** Open the print/save-as-PDF window for a built report (shared by the Print
 *  button and, on local-first, the email-capture button). */
function openPrintWindow(html: string): boolean {
  const printWindow = window.open('', '_blank');
  if (!printWindow) return false;
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.print();
  return true;
}

interface PlanPrint {
  printStatus: 'idle' | 'loading';
  pdfBlocked: PdfButton | null;
  pdfOpened: boolean;
  printing: boolean;
  /** Build the report and open its window; the capture's print calls this directly. */
  printReport: (at: PdfButton) => Promise<void>;
  /** Save as PDF: saves the pending values first, one press at a time. */
  handlePrint: (at: PdfButton) => Promise<void>;
  /** An erase forgets the window this record opened. */
  forget: () => void;
}

/**
 * Save as PDF's state (US-18 AC6, US-09 AC19). Its states, each its own flag because
 * they overlap:
 * - idle: nothing running (`printStatus` 'idle').
 * - saving the pending values: Save as PDF awaits onSaveLongitudinal (`printStatus` 'loading').
 * - building the report: the hidden copy drawn inside the click while getReportHtml
 *   copies it (`printing`, synchronous; still 'loading' under Save as PDF).
 * - the last window refused at a button (`pdfBlocked`): the last try's outcome, emptied
 *   before each try, and when the plan goes.
 * - a window opened in this record (`pdfOpened`): sticky until an erase calls `forget`;
 *   the plan also goes blank mid-edit.
 * The capture's print runs printReport alone, outside `printStatus`; the two buttons are
 * never on screen together.
 */
export function usePlanPrint(hasPlan: boolean, hasUnsavedLongitudinal?: boolean, onSaveLongitudinal?: () => Promise<unknown>): PlanPrint {
  const [printStatus, setPrintStatus] = useState<'idle' | 'loading'>('idle');
  const [pdfBlocked, setPdfBlocked] = useState<PdfButton | null>(null);
  if (!hasPlan && pdfBlocked) setPdfBlocked(null);
  const [pdfOpened, setPdfOpened] = useState(false);
  const [printing, setPrinting] = useState(false);
  // Emptied first (inside the click) so a repeat refusal is announced again.
  const printReport = async (at: PdfButton) => {
    setPdfBlocked(null);
    // Drawn synchronously, inside the click, so getReportHtml copies it before its first await.
    flushSync(() => setPrinting(true));
    const pending = getReportHtml();
    setPrinting(false);
    const report = await pending;
    const opened = report.success && !!report.html && openPrintWindow(report.html);
    setPdfBlocked(opened ? null : at);
    if (opened) setPdfOpened(true);
    else trackProductEvent('pdf_window_blocked');
  };

  const handlePrint = async (at: PdfButton) => {
    if (printStatus === 'loading') return;
    setPrintStatus('loading');
    setPdfBlocked(null); // before the save's await, for the same reason
    // Include pending longitudinal values in the locally generated report.
    if (hasUnsavedLongitudinal && onSaveLongitudinal) {
      try { await onSaveLongitudinal(); } catch { /* proceed with saved data */ }
    }
    await printReport(at);
    setPrintStatus('idle');
  };

  return { printStatus, pdfBlocked, pdfOpened, printing, printReport, handlePrint, forget: () => setPdfOpened(false) };
}

/** Which email box the PDF box holds: the gate (US-18), US-44's reminders, or none once captured. */
type EmailBox = 'gate' | 'reminders' | null;

export function emailBox(state: GuestEmailState, gateSkipped: boolean): EmailBox {
  if (state === 'captured') return null;
  return gateSkipped ? 'reminders' : 'gate';
}

/**
 * The PDF box's mode (US-62 AC26): its email box, and whether the ungated Save as PDF
 * shows. Save as PDF: always on Pages. On Shopify the email capture is the PDF path,
 * so the ungated button shows once captured, on US-44's gate-skipped page, or for a
 * known minor (US-07 AC6). `emailCapture` already excludes a minor, and implies a plan.
 */
export function pdfBox({ planned, adult, emailCapture, state, gateSkipped, shopify }: {
  planned: boolean; adult: boolean; emailCapture: boolean; state: GuestEmailState; gateSkipped: boolean; shopify: boolean;
}): { email: EmailBox; save: boolean } {
  return {
    email: emailCapture ? emailBox(state, gateSkipped) : null,
    save: planned && (!shopify || state === 'captured' || gateSkipped || !adult),
  };
}

/**
 * US-09 AC19: the guest has their PDF (or, on the gate-skipped page, signed up for
 * reminders, which marks the record captured), so the storage button may pulse. Never
 * before, so the pulse never competes with the email box. A known minor has no email
 * box: their Save as PDF counts, as on the gate-skipped page (US-07 AC6). Pages has no
 * email gate or funnel, even for a record captured on Shopify.
 */
export function storagePulse({ shopify, state, gateSkipped, knownMinor, pdfOpened }: {
  shopify: boolean; state: GuestEmailState; gateSkipped: boolean; knownMinor: boolean; pdfOpened: boolean;
}): boolean {
  return shopify && (state === 'captured' || state === 'reminded' || ((gateSkipped || knownMinor) && pdfOpened));
}

interface GuestEmailHook {
  email: string;
  setEmail: (v: string) => void;
  emailError: string;
  setEmailError: (v: string) => void;
  state: GuestEmailState;
  helperText: string;
  handleSubmit: () => void;
  /** US-44: this page's block skips the email gate (read from the page, never stored). */
  gateSkipped?: boolean;
}

/** The capture's state and the page's gate, held by usePlanView (the storage pulse reads them). */
interface EmailCaptureState {
  state: GuestEmailState; setState: (s: GuestEmailState) => void; gateSkipped: boolean;
  /** The box's typing, kept here without a re-render, so the box moving (the full form opening) keeps it. */
  draft: React.MutableRefObject<string>;
  sending: React.MutableRefObject<boolean>; // US-18 AC7: one send at a time, kept here for the same reason.
}

export function useEmailCaptureState(): EmailCaptureState {
  // US-44: the page decides, once per mount. Never written to the record.
  const [gateSkipped] = useState(getSkipEmailGate);
  // Returning local-first users who already captured: skip the email box and
  // land straight on the "Save as PDF" view (the flag lives in their own cloud).
  const [state, setState] = useState<GuestEmailState>(
    () => (getReportEmailCaptured() ? 'captured' : gateSkipped ? 'skipped' : 'idle'),
  );
  const draft = useRef('');
  const sending = useRef(false);
  return { state, setState, gateSkipped, draft, sending };
}

/** The box's own typing, in the PDF box, so a keystroke re-renders the box alone. */
function useGuestEmailCapture(printReport: () => Promise<void>, { state, setState, gateSkipped, draft, sending }: EmailCaptureState): GuestEmailHook {
  const [email, setTyped] = useState(() => draft.current);
  const setEmail = (value: string) => { draft.current = value; setTyped(value); };
  const [emailError, setEmailError] = useState('');
  const helperText = LOCAL_FIRST_EMAIL_HELPER;
  // US-18 AC7: the button is disabled while sending, but Enter reaches here too.

  const handleSubmit = async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      await submit();
    } finally {
      sending.current = false;
    }
  };

  const submit = async () => {
    const trimmed = email.trim();
    if (!trimmed || !EMAIL_REGEX.test(trimmed)) {
      setEmailError('Please enter a valid email address');
      return;
    }
    setEmailError('');
    setState('sending');
    const erase = getShownErase(); // the record the capture was asked for, not the one shown when it lands (US-16 AC2d)

    if (gateSkipped) {
      // US-44 AC3: reminders only. The PDF has its own button, so no print
      // window. Same enrolment call as below. A successful sign-up marks the
      // record captured (Brad, 2026-10-03), so the plan-ready and reminder
      // emails' link back to /pages/roadmap doesn't ask for the email again.
      const result = await sendGuestReport(trimmed);
      if (result.success) {
        markReportEmailCaptured(erase);
        setState('reminded');
      } else {
        setEmailError(result.error || 'Failed to send. Please try again.');
        setState('skipped');
      }
      return;
    }

    // Local-first: the button DELIVERS the plan — open the save-as-PDF window
    // FIRST (it builds client-side, so this stays inside the click's user
    // activation; opening after the network await would trip popup blockers),
    // then subscribe the email to Klaviyo in the background (no plan is emailed).
    await printReport();

    const result = await sendGuestReport(trimmed);

    if (result.success) {
      trackABConversion();
      // Local-first: the PDF window already opened (the delivery). Persist the
      // captured flag to the user's own cloud and switch to the "Save as PDF"
      // view — no email box on return, nothing extra (no articles screen).
      markReportEmailCaptured(erase);
      setState('captured');
    } else {
      setEmailError(result.error || 'Failed to send. Please try again.');
      setState('idle');
    }
  };

  return { email, setEmail, emailError, setEmailError, state, helperText, handleSubmit, gateSkipped };
}

/** US-44: the funnel page's box. The gate is skipped (Save as PDF sits in the
 *  plan header), so this only enrols check-up reminders, and only if asked. */
function ReminderSignup({ hook }: { hook: GuestEmailHook }) {
  const { email, setEmail, emailError, setEmailError, state, handleSubmit } = hook;

  if (state === 'reminded') {
    return (
      <div className="email-capture no-print">
        <p className="email-guest-helper" role="status">{REMINDER_SIGNUP_DONE}</p>
      </div>
    );
  }

  return (
    <div className="email-capture no-print">
      <label htmlFor="reminderEmail" className="email-capture-label">{REMINDER_SIGNUP_LABEL}</label>
      <p className="email-guest-helper">{REMINDER_SIGNUP_HELPER}</p>
      <div className="email-capture-row">
        <input
          type="email"
          id="reminderEmail"
          placeholder="Email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setEmailError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          className={emailError ? 'error' : ''}
        />
        <button
          type="button"
          className="btn-primary"
          onClick={handleSubmit}
          disabled={state === 'sending'}
        >
          {state === 'sending' ? 'Sending...' : REMINDER_SIGNUP_BUTTON}
        </button>
      </div>
      {emailError && <span className="email-capture-error">{emailError}</span>}
    </div>
  );
}

export function GuestEmailCapture({ hook, formStage, pdfBlocked }: {
  hook: GuestEmailHook;
  formStage?: number;
  /** US-18 AC6: this capture's print window was refused. */
  pdfBlocked?: boolean;
}) {
  const { email, setEmail, emailError, setEmailError, state, helperText, handleSubmit } = hook;
  const box = emailBox(state, !!hook.gateSkipped);

  // Already captured (this submit, or a prior visit via the persisted flag):
  // the email box is gone and nothing renders here. The ungated "Save as PDF"
  // button sits beside it in the same PDF box instead.
  if (!box) return null;

  if (box === 'reminders') return <ReminderSignup hook={hook} />;

  return (
    <div className={`email-capture no-print${formStage === 4 ? ' field-attention' : ''}`}>
      <p className="email-guest-helper">{helperText}</p>
      <div className="email-capture-row">
        <input
          type="email"
          id={formStage !== undefined ? 'guestEmail' : undefined}
          placeholder="Email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setEmailError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          className={emailError ? 'error' : ''}
        />
        <button
          type="button"
          className="btn-primary"
          onClick={handleSubmit}
          disabled={state === 'sending'}
        >
          {state === 'sending' ? 'Sending...' : GUEST_CAPTURE_BUTTON_LABEL}
        </button>
      </div>
      {emailError && <span className="email-capture-error">{emailError}</span>}
      <PdfNote show={!!pdfBlocked && !!emailError} />
    </div>
  );
}

/** My health's PDF box (US-62 AC26): the email box, or Save as PDF. It owns the box's typing, so a
 *  keystroke re-renders the box alone. Null when neither shows. */
export function PlanPdf({ planned, adult, emailCapture, formStage, capture, printStatus, pdfBlocked, onPrint, onCapturePrint }: {
  planned: boolean; adult: boolean; emailCapture: boolean; formStage?: number; capture: EmailCaptureState;
  printStatus: 'idle' | 'loading'; pdfBlocked: PdfButton | null; onPrint: (at: PdfButton) => void; onCapturePrint: () => Promise<void>;
}) {
  const guestEmailHook = useGuestEmailCapture(onCapturePrint, capture);
  const printLabel = printStatus === 'loading' ? 'Loading...' : 'Save as PDF';
  const mode = pdfBox({ planned, adult, emailCapture, state: capture.state, gateSkipped: capture.gateSkipped, shopify: SHOPIFY_SURFACE });
  const box = mode.email && <GuestEmailCapture hook={guestEmailHook} formStage={formStage} pdfBlocked={pdfBlocked === 'capture'} />;
  if (!box && !mode.save) return null;
  return (
    <div className="mh-pdf">
      {box}
      {mode.save && (
        <div className="report-actions no-print">
          <button type="button" className="action-btn" onClick={() => onPrint('bottom')} disabled={printStatus === 'loading'} title="Save your plan as a PDF">
            {printLabel}
          </button>
          <PdfNote show={pdfBlocked === 'bottom' || pdfBlocked === 'capture'} />
        </div>
      )}
    </div>
  );
}
