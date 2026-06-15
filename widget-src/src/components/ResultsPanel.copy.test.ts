import { describe, it, expect } from 'vitest';
import {
  DEFAULT_EMAIL_HELPER,
  LOCAL_FIRST_EMAIL_HELPER,
  GUEST_CAPTURE_BUTTON_LABEL,
} from './ResultsPanel';

// Brad locked this copy on 2026-06-15. On every LIVE (LOCAL_FIRST) surface the
// guest plan-capture CTA opens the browser save-as-PDF window — the email field
// only subscribes to Klaviyo, no plan is ever emailed. So the visible copy must
// promise a PDF and must NOT claim anything is "emailed"/"email you"/"sent".
//
// These constants drive the rendered CTA directly (helperText + button label),
// so asserting them is equivalent to asserting the rendered text without
// needing a DOM/jsdom render.

const HEADLINE =
  'Get a PDF of your personalized plan, with detailed explanations and clinical references for every suggestion.';

describe('guest plan-capture CTA copy (PDF, not email)', () => {
  it('LOCAL_FIRST helper (the live production copy) is the locked PDF headline', () => {
    expect(LOCAL_FIRST_EMAIL_HELPER).toBe(HEADLINE);
  });

  it('DEFAULT helper is accurate too (dead variant, but no false email promise)', () => {
    expect(DEFAULT_EMAIL_HELPER).toBe(HEADLINE);
  });

  it('button label is the locked "Get My PDF Plan"', () => {
    expect(GUEST_CAPTURE_BUTTON_LABEL).toBe('Get My PDF Plan');
  });

  it('no CTA copy mentions email/emailed/sent (the framing is now inaccurate)', () => {
    for (const copy of [LOCAL_FIRST_EMAIL_HELPER, DEFAULT_EMAIL_HELPER, GUEST_CAPTURE_BUTTON_LABEL]) {
      expect(copy.toLowerCase()).not.toMatch(/email|sent/);
    }
  });
});
