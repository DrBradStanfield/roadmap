import React, { useEffect, useReducer, useRef, useState } from 'react';
import { sendFeedback } from '../lib/server-api';

/**
 * The form's mode (US-19 AC3): closed (the "Send feedback" link), open, sending, failed (open,
 * saying so) or sent (the thank-you, which closes itself after 3 s). Sending names its send, and
 * an answer counts only for the send it names, so one that ends after Cancel, or while a newer
 * send runs, changes nothing.
 */
export type FeedbackMode =
  | { kind: 'closed' } | { kind: 'open' } | { kind: 'sending'; sendId: symbol } | { kind: 'failed' } | { kind: 'sent' };
export type FeedbackEvent =
  | { type: 'expand' } | { type: 'close' } | { type: 'thanked' }
  | { type: 'send' | 'sendFailed' | 'sendOk'; sendId: symbol };

export function feedbackTransition(state: FeedbackMode, event: FeedbackEvent): FeedbackMode {
  const { kind } = state;
  switch (event.type) {
    case 'expand': return kind === 'closed' ? { kind: 'open' } : state;
    case 'close': return kind === 'open' || kind === 'sending' || kind === 'failed' ? { kind: 'closed' } : state;
    case 'send': return kind === 'open' || kind === 'failed' ? { kind: 'sending', sendId: event.sendId } : state;
    case 'thanked': return kind === 'sent' ? { kind: 'closed' } : state;
  }
  if (kind !== 'sending' || state.sendId !== event.sendId) return state;
  return { kind: event.type === 'sendOk' ? 'sent' : 'failed' };
}

interface FeedbackFormProps {
  /** Start with the form expanded (no toggle button shown). */
  initialExpanded?: boolean;
  /** Called when the form is closed/cancelled. */
  onClose?: () => void;
  /** Show the "View source code" link. Default true. */
  showSourceLink?: boolean;
}

export function FeedbackForm({ initialExpanded = false, onClose, showSourceLink = true }: FeedbackFormProps) {
  const [mode, send] = useReducer(feedbackTransition, { kind: initialExpanded ? 'open' : 'closed' });
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');

  const formRef = useRef<HTMLFormElement>(null);
  const formShown = mode.kind === 'open' || mode.kind === 'sending' || mode.kind === 'failed';
  const canSubmit = email.trim() !== '' && message.trim() !== '' && mode.kind !== 'sending';
  // The latest onClose, so a parent's new callback each render does not restart the thank-you.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (formShown) {
      requestAnimationFrame(() => {
        formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
      });
    }
  }, [formShown]);

  // A sent message empties the form; the thank-you closes it after 3 s and, gone with the form, never fires.
  useEffect(() => {
    if (mode.kind !== 'sent') return;
    setEmail('');
    setMessage('');
    const timer = setTimeout(() => { send({ type: 'thanked' }); onCloseRef.current?.(); }, 3000);
    return () => clearTimeout(timer);
  }, [mode.kind]);

  function handleClose() {
    send({ type: 'close' });
    onClose?.();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    const sendId = Symbol('feedback-send');
    send({ type: 'send', sendId });
    const success = await sendFeedback(email.trim(), message.trim());
    send({ type: success ? 'sendOk' : 'sendFailed', sendId });
  }

  return (
    <div className="feedback-section" id={initialExpanded ? undefined : 'health-feedback'}>
      {mode.kind === 'sent' ? (
        <p className="feedback-success">Thank you for your feedback!</p>
      ) : !formShown ? (
        <div className="feedback-links">
          <button
            type="button"
            className="feedback-btn"
            onClick={() => send({ type: 'expand' })}
          >
            Send feedback
          </button>
          {showSourceLink && (
            <a
              href="https://github.com/DrBradStanfield/roadmap"
              target="_blank"
              rel="noopener noreferrer"
              className="source-code-link"
            >
              View source code
            </a>
          )}
        </div>
      ) : (
        <form ref={formRef} className="feedback-form" onSubmit={handleSubmit}>
          <label className="feedback-label">
            Email
            <input
              type="email"
              className="feedback-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              maxLength={200}
            />
          </label>
          <label className="feedback-label">
            Message
            <textarea
              className="feedback-textarea"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Your feedback..."
              required
              maxLength={2000}
              rows={4}
            />
          </label>
          {/* Honeypot — hidden from real users */}
          <div aria-hidden="true" style={{ position: 'absolute', left: '-9999px', opacity: 0 }}>
            <input type="text" name="website" tabIndex={-1} autoComplete="off" />
          </div>
          {mode.kind === 'failed' && (
            <p className="feedback-error">Failed to send. Please try again.</p>
          )}
          <div className="feedback-actions">
            <button
              type="submit"
              className="btn-primary feedback-submit"
              disabled={!canSubmit}
            >
              {mode.kind === 'sending' ? 'Sending...' : 'Send'}
            </button>
            <button
              type="button"
              className="feedback-cancel"
              onClick={handleClose}
            >
              Cancel
            </button>
          </div>
          {showSourceLink && (
            <a
              href="https://github.com/DrBradStanfield/roadmap"
              target="_blank"
              rel="noopener noreferrer"
              className="source-code-link"
            >
              View source code
            </a>
          )}
        </form>
      )}
    </div>
  );
}
