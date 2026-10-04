/**
 * US-22 AC13 — an arrival from an email that finds the tool empty.
 *
 * Both email buttons go through /roadmap/open, which lands on the page with
 * `from=email` (a literal on the server, never request input). A guest's plan
 * lives only in the browser they made it in, and Safari clears that after a
 * week without a visit, so the button often opens a blank form. Without a word
 * of explanation that reads as "my plan is gone" (Darren, 2026-09-24).
 *
 * Kept out of app.tsx, which runs on import and so cannot be tested.
 */
import { useEffect, useRef, useState } from 'react';
import { hasSavedRecord, loadLatestMeasurements } from '../src/lib/roadmap-data';
import { trackProductEvent } from '../src/lib/server-api';
import { openBackendPicker } from '../src/lib/storage-notice';
import type { StorageState } from './connect';

/** Exactly what the server redirect appends. Nothing else counts as the flag. */
const EMAIL_FLAG = 'from=email';

/** US-22 AC14: what Copy link writes, for the browser that holds the plan. A
 *  literal, never location.href, which carries whatever the click arrived with. */
const ROADMAP_ADDRESS = 'https://drstanfield.com/pages/roadmap';

const COPY_LABEL = { idle: 'Copy link', copied: 'Copied', manual: 'Select and copy the address' };

/**
 * Read the email flag, and strip it from the address bar so a reload or a
 * copied link never repeats the notice. Every other parameter keeps its exact
 * bytes, and the hash and history.state stay. Synchronous, so main() takes it
 * before its first await.
 */
export function takeEmailFlag(): boolean {
  const params = location.search.slice(1).split('&');
  const kept = params.filter((param) => param !== EMAIL_FLAG);
  if (kept.length === params.length) return false;
  const search = kept.length ? `?${kept.join('&')}` : '';
  try {
    history.replaceState(history.state, '', `${location.pathname}${search}${location.hash}`);
  } catch {
    /* the notice still shows; the flag just stays in the address bar */
  }
  return true;
}

/**
 * The notice is for a guest arriving from an email to an empty record, and no
 * one else: a cloud session loads the plan, and a reconnect session already
 * names the provider holding it. Counted when it shows. Recovery is the same
 * visitor then firing results_viewed or cloud_connect_success.
 */
export async function emailLandingApplies(fromEmail: boolean, state: StorageState): Promise<boolean> {
  if (!fromEmail || state !== 'guest') return false;
  // Awaited before the widget mounts: a read that fails shows no notice,
  // never a rejection into an empty mount (US-09 AC16).
  const empty = await loadLatestMeasurements().then((result) => !hasSavedRecord(result), () => false);
  if (!empty) return false;
  trackProductEvent('email_landing_empty');
  return true;
}

/** Above the widget, in ConnectRefusedNotice's slot: visible on the input tab,
 *  where every mobile arrival lands. Most empty landings are the mail app's own
 *  browser (US-22 AC14), so the notice first says to open the page in the one
 *  that holds the plan. Connect opens the storage picker. */
export function EmailLandingNotice() {
  const [shown, setShown] = useState(true);
  const [copy, setCopy] = useState<keyof typeof COPY_LABEL>('idle');
  const address = useRef<HTMLSpanElement>(null);
  // The Copied reset, cleared on every press, Dismiss and unmount, so a stale
  // one never overwrites a newer label.
  const reset = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(reset.current), []);
  if (!shown) return null;
  const copyLink = () => {
    clearTimeout(reset.current);
    // The executor runs inside the click (WebKit wants the write in the
    // gesture), and a missing clipboard API throws into the same rejection as
    // a refusal: select the address for a copy by hand.
    new Promise<void>((resolve) => resolve(navigator.clipboard.writeText(ROADMAP_ADDRESS)))
      .then(
        () => {
          trackProductEvent('email_landing_link_copied');
          setCopy('copied');
          reset.current = setTimeout(() => setCopy('idle'), 2000);
        },
        () => {
          const range = document.createRange();
          if (address.current) range.selectNodeContents(address.current);
          getSelection()?.removeAllRanges();
          getSelection()?.addRange(range);
          setCopy('manual');
        },
      );
  };
  return (
    <div className="hr-sync hr-page-notice" role="status">
      <p className="hr-page-notice-lead">
        <strong>Opened this from your email app?</strong> Your plan is in the browser where you made it. Open{' '}
        <span ref={address}>drstanfield.com/pages/roadmap</span> there.
      </p>
      <span className="hr-sync-status">Looking for your plan?</span>
      <p className="hr-sync-detail">
        If you saved it to Google Drive or Dropbox, connect it and it loads. If not, it stays only in the
        browser you made it in, and Safari can clear that after a week without a visit. Your PDF still has it,
        if you saved one.
      </p>
      <button type="button" className="hr-sync-btn" onClick={openBackendPicker}>Connect</button>
      <button type="button" className="hr-sync-btn" onClick={copyLink}>{COPY_LABEL[copy]}</button>
      <button
        type="button"
        className="hr-sync-link hr-page-notice-dismiss"
        onClick={() => {
          clearTimeout(reset.current);
          setShown(false);
        }}
      >
        Dismiss
      </button>
    </div>
  );
}
