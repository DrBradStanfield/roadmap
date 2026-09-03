// @vitest-environment jsdom
/**
 * US-09 AC5 — a guest is told where the record lives as soon as the first value
 * is entered, and every mention of Dropbox or Google Drive opens the picker.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import {
  EMAIL_STORAGE_NOTICE,
  INPUT_STORAGE_NOTICE,
  OPEN_PICKER_EVENT,
  PLAN_STORAGE_CTA,
  PLAN_STORAGE_NOTICE,
  StorageNotice,
  StorageNoticeContext,
  UPLOAD_STORAGE_NOTICE,
  type StorageSurface,
} from './storage-notice';

afterEach(cleanup);

const guest = (ui: React.ReactNode, connected = false) =>
  render(<StorageNoticeContext.Provider value={!connected}>{ui}</StorageNoticeContext.Provider>);

describe('US-09 AC5 — the context gate', () => {
  it('shows the sentence while the guest still has a choice to make', () => {
    const { container } = guest(<StorageNotice surface="input" />);
    expect(container.textContent).toBe(INPUT_STORAGE_NOTICE);
  });

  it('renders nothing once a cloud is connected', () => {
    const { container } = guest(<StorageNotice surface="input" />, true);
    expect(container.textContent).toBe('');
  });

  it('renders nothing where no picker host is mounted (the default)', () => {
    const { container } = render(<StorageNotice surface="input" />);
    expect(container.textContent).toBe('');
  });

  it('always carries the base class, plus the caller’s surface class', () => {
    const { container } = guest(<StorageNotice surface="email" className="email-guest-helper" />);
    const p = container.querySelector('p')!;
    expect(p.className).toBe('hr-storage-notice email-guest-helper');
    expect(guest(<StorageNotice surface="input" />).container.querySelector('p')!.className)
      .toBe('hr-storage-notice');
  });
});

describe('US-09 AC5 — every mention opens the picker', () => {
  for (const [surface, text] of [
    ['input', INPUT_STORAGE_NOTICE],
    ['email', EMAIL_STORAGE_NOTICE],
    ['plan', PLAN_STORAGE_NOTICE],
  ] as [StorageSurface, string][]) {
    it(`${surface}: "Dropbox or Google Drive" is a focusable button that opens the picker`, () => {
      const open = vi.fn();
      window.addEventListener(OPEN_PICKER_EVENT, open);
      const { getByRole, container } = guest(<StorageNotice surface={surface} />);
      const link = getByRole('button', { name: 'Dropbox or Google Drive' });
      expect(link.tagName).toBe('BUTTON');
      fireEvent.click(link);
      window.removeEventListener(OPEN_PICKER_EVENT, open);
      expect(open).toHaveBeenCalledTimes(1);
      // The whole sentence renders around the link — the split cannot drop text.
      expect(container.textContent).toBe(text);
    });
  }
});

describe('US-09 AC5 — locked copy', () => {
  it('says our server, never Dr Brad’s servers, and carries no em dash', () => {
    for (const copy of [
      INPUT_STORAGE_NOTICE, EMAIL_STORAGE_NOTICE, PLAN_STORAGE_NOTICE, PLAN_STORAGE_CTA, UPLOAD_STORAGE_NOTICE,
    ]) {
      expect(copy).not.toMatch(/—/);
      expect(copy).not.toMatch(/Dr Brad/);
    }
    expect(PLAN_STORAGE_NOTICE).toContain('Nothing is stored on our server.');
    expect(UPLOAD_STORAGE_NOTICE).toContain('Nothing is stored on our server.');
    expect(PLAN_STORAGE_CTA).toBe('Where do you want to keep your health record?');
  });

  it('pins the approved sentences word for word', () => {
    expect(INPUT_STORAGE_NOTICE).toBe(
      'Your health record stays in your browser until you choose if you want to store it in your Dropbox or Google Drive.',
    );
    expect(PLAN_STORAGE_NOTICE).toBe(
      'Your health record is yours, and yours alone. Keep it in your own Dropbox or Google Drive. Nothing is stored on our server.',
    );
  });
});
