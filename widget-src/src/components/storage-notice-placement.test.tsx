// @vitest-environment jsdom
/**
 * US-09 AC5 — where the storage sentence sits, not just what it says.
 *
 * Both defects this pins were invisible to the copy tests: on the plan tab the
 * sentence landed above the email box instead of under the last helper line,
 * and on the input tab it ran to the screen edge because it is a sibling of the
 * cards, not a child, so it missed their mobile gutter.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { EMAIL_STORAGE_NOTICE, StorageNoticeContext } from '../lib/storage-notice';

vi.mock('../lib/api', () => ({
  sendReportEmail: vi.fn(), getReportHtml: vi.fn(), sendGuestReport: vi.fn(),
  trackABConversion: vi.fn(), getABAssignments: () => ({}), getReportEmailCaptured: () => false,
  markReportEmailCaptured: vi.fn(), trackProductEvent: vi.fn(),
}));

import { GuestEmailCapture } from './ResultsPanel';

afterEach(cleanup);

const hook = {
  email: '', setEmail: vi.fn(), emailError: '', setEmailError: vi.fn(),
  state: 'idle' as const, setState: vi.fn(),
  helperText: 'Get a PDF of your personalized plan.', handleSubmit: vi.fn(),
};

describe('US-09 AC5 — plan tab, email box', () => {
  it('the storage sentence follows the reminders helper line, last in the block', () => {
    const { container } = render(
      <StorageNoticeContext.Provider value><GuestEmailCapture hook={hook} /></StorageNoticeContext.Provider>,
    );
    const notice = container.querySelector('.hr-storage-notice')!;
    expect(notice.textContent).toBe(EMAIL_STORAGE_NOTICE);
    expect(notice.previousElementSibling!.className).toBe('email-capture-disclosure');
    expect(notice.parentElement!.lastElementChild).toBe(notice);
  });
});

describe('US-09 AC5 — input tab gutter', () => {
  it('the sentence carries the same mobile gutter as the cards it sits under', () => {
    const css = readFileSync('widget-src/src/styles.css', 'utf8').replace(/\s+/g, ' ');
    expect(css).toContain('.section-card { padding: 12px !important; margin-left: 10px; margin-right: 10px; }');
    expect(css).toContain('.health-input-panel > .hr-storage-notice { margin-left: 10px; margin-right: 10px; }');
  });
});
