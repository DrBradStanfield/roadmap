// My health's PDF box (US-62 AC26, US-18, US-44): Save as PDF and the email capture
// beside it. usePlanView holds the print state and hands the box what it draws.
import React, { useState, useRef } from 'react';
import { sendGuestReport, getReportEmailCaptured, markReportEmailCaptured } from '../lib/roadmap-data';
import { trackABConversion } from '../lib/server-api';
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
export type PdfButton = 'bottom' | 'capture';

/** US-18 AC6: always mounted and emptied before each try, so every refusal is announced. */
function PdfNote({ show }: { show: boolean }) {
  return <span className="hr-pdf-blocked no-print" role="status">{show ? PDF_WINDOW_BLOCKED : ''}</span>;
}

/** Open the print/save-as-PDF window for a built report (shared by the Print
 *  button and, on local-first, the email-capture button). */
export function openPrintWindow(html: string): boolean {
  const printWindow = window.open('', '_blank');
  if (!printWindow) return false;
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.print();
  return true;
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

    if (gateSkipped) {
      // US-44 AC3: reminders only. The PDF has its own button, so no print
      // window. Same enrolment call as below. A successful sign-up marks the
      // record captured (Brad, 2026-10-03), so the plan-ready and reminder
      // emails' link back to /pages/roadmap doesn't ask for the email again.
      const result = await sendGuestReport(trimmed);
      if (result.success) {
        markReportEmailCaptured();
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
      markReportEmailCaptured();
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

  if (state === 'captured') {
    // Already captured (this submit, or a prior visit via the persisted flag):
    // the email box is gone and nothing renders here. The ungated "Save as PDF"
    // button sits beside it in the same PDF box instead.
    return null;
  }

  if (hook.gateSkipped) return <ReminderSignup hook={hook} />;

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
  // Save as PDF: always on Pages. On Shopify the email capture is the PDF path,
  // so the ungated button shows once captured, on US-44's gate-skipped page, or
  // for a known minor.
  const ungatedPdf = planned && (!SHOPIFY_SURFACE || capture.state === 'captured' || capture.gateSkipped || !adult);
  const box = emailCapture && <GuestEmailCapture hook={guestEmailHook} formStage={formStage} pdfBlocked={pdfBlocked === 'capture'} />;
  if (!box && !ungatedPdf) return null;
  return (
    <div className="mh-pdf">
      {box}
      {ungatedPdf && (
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
