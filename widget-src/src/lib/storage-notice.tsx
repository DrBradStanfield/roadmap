/**
 * US-09 AC5 — the storage promise, said early and said the same way everywhere.
 *
 * `src/` must never import `standalone/`, so the `hr:open-backend-picker` window
 * event is the one seam to the picker: openBackendPicker() is the only way in,
 * and standalone/sync-control.tsx is the only listener.
 */
import { createContext, useContext } from 'react';

export const OPEN_PICKER_EVENT = 'hr:open-backend-picker';

/** True only when a picker host is mounted AND no cloud is connected. */
export const StorageNoticeContext = createContext(false);

const LINK_TEXT = 'Dropbox or Google Drive';

/** Each sentence is stored split around the link, so the split cannot silently
 *  fail the way a `.split()` on a drifting sentence would. */
const PARTS = {
  input: [
    'Your health record stays in your browser until you choose if you want to store it in your ',
    '.',
  ],
  email: [
    'Your health record stays in your browser until you choose to keep it in your ',
    '.',
  ],
  plan: [
    'Your health record is yours, and yours alone. Keep it in your own ',
    '. Nothing is stored on our server.',
  ],
} as const satisfies Record<string, readonly [string, string]>;

export type StorageSurface = keyof typeof PARTS;

const sentence = (surface: StorageSurface): string => PARTS[surface][0] + LINK_TEXT + PARTS[surface][1];

export const INPUT_STORAGE_NOTICE = sentence('input');
export const EMAIL_STORAGE_NOTICE = sentence('email');
export const PLAN_STORAGE_NOTICE = sentence('plan');
export const PLAN_STORAGE_CTA = 'Where do you want to keep your health record?';
/** The upload modal's own paragraph (plain prose; the CTA button beneath it is
 *  the affordance there). */
export const UPLOAD_STORAGE_NOTICE =
  'Keep the files themselves in your own Dropbox or Google Drive, sorted into Lab results, Clinic letters and Scans. Nothing is stored on our server.';

export function openBackendPicker(): void {
  window.dispatchEvent(new Event(OPEN_PICKER_EVENT));
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
      <button type="button" className="hr-storage-link" onClick={openBackendPicker}>
        {LINK_TEXT}
      </button>
      {after}
    </p>
  );
}

/** The same sentence, shown only where the guest still has a choice to make. */
export function StorageNotice(props: { surface: StorageSurface; className?: string }) {
  return useContext(StorageNoticeContext) ? <StorageSentence {...props} /> : null;
}
