/**
 * US-09 AC5 — the storage promise, said once, in the plan's storage card
 * (Brad 2026-11-02), with the provider names opening the picker.
 *
 * `src/` must never import `standalone/`, so the `hr:open-backend-picker` window
 * event is the one seam to the picker: openBackendPicker() is the only way in,
 * and standalone/sync-control.tsx is the only listener.
 */
import { createContext } from 'react';
import type { SIGNIN_PLACEMENTS } from '@roadmap/health-core/product-events';
import { trackProductEvent } from './server-api';

export const OPEN_PICKER_EVENT = 'hr:open-backend-picker';

/** A true guest: the record on this device, no provider to reconnect (standalone/app.tsx sets it
 *  once per page load). Only a guest's storage card heads a phone's Account (US-62 AC34). */
export const GuestContext = createContext(false);

const LINK_TEXT = 'Dropbox or Google Drive';

/** Each sentence is stored split around the link, so the split cannot silently
 *  fail the way a `.split()` on a drifting sentence would. */
const PARTS = {
  plan: [
    'Your health record is yours, and yours alone. Keep it in your own ',
    '. Our server never stores your health record.',
  ],
} as const satisfies Record<string, readonly [string, string]>;

export type StorageSurface = keyof typeof PARTS;

const sentence = (surface: StorageSurface): string => PARTS[surface][0] + LINK_TEXT + PARTS[surface][1];

export const PLAN_STORAGE_NOTICE = sentence('plan');
/** The storage card's sign-in button (Brad 2026-11-09). */
export const PLAN_STORAGE_CTA = 'Keep my record in Dropbox or Google Drive';
/** The picker's own title: the question the button opens. */
export const PICKER_TITLE = 'Where do you want to keep your health record?';
/** The upload modal's own paragraph (plain prose; the CTA button beneath it is
 *  the affordance there). */
export const UPLOAD_STORAGE_NOTICE =
  'Keep the files themselves in your own Dropbox or Google Drive, sorted into Lab results, Clinic letters and Scans. Our server never stores them.';

export function openBackendPicker(): void {
  window.dispatchEvent(new Event(OPEN_PICKER_EVENT));
}

/** US-62 AC3: a guest opens the picker from a sign-in prompt, counted by where. */
export function openSignin(placement: (typeof SIGNIN_PLACEMENTS)[number]): void {
  trackProductEvent('signin_opened', { placement });
  openBackendPicker();
}

/** One storage sentence, with the provider names as a keyboard-focusable link. */
export function StorageSentence({ surface, className = '' }: {
  surface: StorageSurface;
  className?: string;
}) {
  const [before, after] = PARTS[surface];
  return (
    <p className={`hr-storage-notice ${className}`.trim()}>
      {before}
      <button type="button" className="hr-storage-link" onClick={() => openSignin('plan_panel')}>
        {LINK_TEXT}
      </button>
      {after}
    </p>
  );
}
