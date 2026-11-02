// @vitest-environment jsdom
/**
 * US-09 AC5 — the plan's storage card says where the record lives, and every
 * mention of Dropbox or Google Drive opens the picker. The Starting Info and
 * PDF-box sentences are gone (Brad 2026-11-02).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import {
  OPEN_PICKER_EVENT,
  PLAN_STORAGE_CTA,
  PLAN_STORAGE_NOTICE,
  StorageSentence,
  UPLOAD_STORAGE_NOTICE,
} from './storage-notice';

afterEach(cleanup);

describe('US-09 AC5 — every mention opens the picker', () => {
  it('plan: "Dropbox or Google Drive" is a focusable button that opens the picker', () => {
    const open = vi.fn();
    window.addEventListener(OPEN_PICKER_EVENT, open);
    const { getByRole, container } = render(<StorageSentence surface="plan" className="hr-sync-detail" />);
    const link = getByRole('button', { name: 'Dropbox or Google Drive' });
    expect(link.tagName).toBe('BUTTON');
    fireEvent.click(link);
    window.removeEventListener(OPEN_PICKER_EVENT, open);
    expect(open).toHaveBeenCalledTimes(1);
    // The whole sentence renders around the link — the split cannot drop text.
    expect(container.textContent).toBe(PLAN_STORAGE_NOTICE);
    expect(container.querySelector('p')!.className).toBe('hr-storage-notice hr-sync-detail');
  });
});

describe('US-09 AC5 — locked copy', () => {
  it('says our server, never Dr Brad’s servers, and carries no em dash', () => {
    for (const copy of [PLAN_STORAGE_NOTICE, PLAN_STORAGE_CTA, UPLOAD_STORAGE_NOTICE]) {
      expect(copy).not.toMatch(/—/);
      expect(copy).not.toMatch(/Dr Brad/);
    }
    // 2026-10-30: "Nothing is stored on our server" was false beside a chat that
    // keeps question rows; the claim is now about the record and the files only.
    // It names the record outright, so it stays true beside a bubble reply
    // that quotes a value (US-15 AC8).
    for (const copy of [PLAN_STORAGE_NOTICE, UPLOAD_STORAGE_NOTICE]) expect(copy).not.toContain('Nothing is stored');
    expect(PLAN_STORAGE_NOTICE).toContain('Our server never stores your health record.');
    expect(PLAN_STORAGE_NOTICE).not.toMatch(/never stores it\b/);
    expect(UPLOAD_STORAGE_NOTICE).toContain('Our server never stores them.');
    expect(PLAN_STORAGE_CTA).toBe('Where do you want to keep your health record?');
  });

  it('pins the approved sentence word for word', () => {
    expect(PLAN_STORAGE_NOTICE).toBe(
      'Your health record is yours, and yours alone. Keep it in your own Dropbox or Google Drive. Our server never stores your health record.',
    );
  });
});
