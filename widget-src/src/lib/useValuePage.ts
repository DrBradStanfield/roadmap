// My data's view state (US-62 AC10, AC11): which value page is open, whether
// the grids show as a table, and the browser history entry a page owns.
//
// The page machine, in one place:
//   rows ──openPage──▶ page(subject) ──switchPage──▶ page(other subject)   (asks first if typed)
//   page ──close / Back──▶ rows, focus back on the row it opened from
//        (after a switch, on what held the focus as it switched)
//   page ──erase / chat reveal──▶ rows (drop: goes back too; its popstate,
//        if it lands before the page unmounts, closes as Back does)
// Back is ignored while My data's tab is hidden; with Settings over the page,
// Back closes Settings and the page keeps its entry. A reload drops a stale entry.
// The view is one named state (lib/value-view-machine): rows or a page, each
// carrying the table toggle; showTable opens and closes it, and a chat edit to
// a grid cell shows it too.
// A page is a history entry (a state marker, no URL change), so the phone's
// back gesture closes it. Typed, unsaved input is not dropped silently:
// leaving asks first, and a chat reveal that drops it says so. An erase
// drops it as it drops everything else (US-16 AC2a).
import { useEffect, useReducer, useRef, type RefObject } from 'react';
import { DRAFTS_CLEARED_EVENT } from './storage';
import { useLiveRegion } from '../components/BloodTestTimeline';
import type { ValueSubject } from '../components/MyDataRows';
import { ROWS, shown, transition, type CameFrom, type RevealCell } from './value-view-machine';

export type { RevealCell };

/** The history-state key a phone value page's entry carries (US-62 AC10). */
const VALUE_PAGE_STATE = 'hrValuePage';
const LEAVE_UNSAVED = 'Leave without saving the value you typed?';
/** Said when a chat edit closes a page that held typed input. */
const TYPED_NOT_SAVED = 'Your typed value was not saved.';

const onPageEntry = () => !!window.history.state?.[VALUE_PAGE_STATE];
const pushPageEntry = () => window.history.pushState({ ...window.history.state, [VALUE_PAGE_STATE]: true }, '');

export function useValuePage(revealCell: RevealCell, panelRef: RefObject<HTMLDivElement | null>) {
  const [view, send] = useReducer(transition, ROWS);
  // A chat reveal closes the value page; only a filled grid cell opens the table (adversary R6).
  const { revealing, page: pageShown, table: tableShown } = shown(view, revealCell);
  const open = view.kind === 'page' ? view : null;
  /** Written by the open page's form as it renders, while it holds typed, unsaved input. */
  const pageDirty = useRef(false);
  const mayLeave = () => !pageDirty.current || window.confirm(LEAVE_UNSAVED);

  // `from` is the row pressed: WebKit does not focus a button on a tap, so the active element is stale.
  const openPage = (subject: ValueSubject, from?: Element) => {
    send({ type: 'open', subject, from: { el: from ?? document.activeElement, y: window.scrollY }, reveal: revealCell });
    if (!onPageEntry()) pushPageEntry();
  };
  /** From one page to another: asks first if the page holds typed input. */
  const switchPage = (subject: ValueSubject) => { if (mayLeave()) openPage(subject); };
  /** Back to the rows, the focus on the row the page opened from. */
  const finishClose = ({ el, y }: CameFrom) => {
    pageDirty.current = false;
    send({ type: 'close' });
    requestAnimationFrame(() => {
      if (el instanceof HTMLElement && el.isConnected) {
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        el.focus({ preventScroll: true });
      } else window.scrollTo?.({ top: y, behavior: 'instant' });
    });
  };
  /** Closed from outside (an erase, a chat reveal): what it held goes, with its entry. */
  const drop = () => {
    send({ type: 'close' });
    pageDirty.current = false;
    if (onPageEntry()) window.history.back();
  };
  // "‹ My data": goes back, so its popstate closes the page.
  const closePage = () => {
    if (!mayLeave()) return;
    pageDirty.current = false;
    if (onPageEntry()) window.history.back();
    else if (open) finishClose(open.from);
  };
  const showTable = (show: boolean) => send({ type: 'table', open: show, reveal: revealCell });
  // A grid mounted hidden never scrolled to its newest column: do it on showing.
  // The vitals grid scrolls whole date columns, so no clipped sliver shows beside its names (H79).
  // Only where Trend scrolls with the data (a phone): a sticky Trend (desktop) would cover New.
  useEffect(() => {
    if (!tableShown) return;
    panelRef.current?.querySelectorAll<HTMLElement>('.md-table .bt-timeline-scroll').forEach(el => {
      const trend = el.querySelector('.bt-header-row .bt-cell-trend');
      const snap = el.closest('.bt-vitals-card') && trend && getComputedStyle(trend).position !== 'sticky';
      const colW = snap ? el.querySelector<HTMLElement>('.bt-header-row .bt-cell-value')?.offsetWidth : 0;
      el.scrollLeft = colW ? Math.floor((el.scrollWidth - el.clientWidth) / colW) * colW : el.scrollWidth;
    });
  }, [tableShown]);

  // A reload on a page's entry opens on the rows: drop the stale marker, so the next page pushes its own.
  useEffect(() => {
    if (onPageEntry()) window.history.replaceState({ ...window.history.state, [VALUE_PAGE_STATE]: undefined }, '');
  }, []);
  // While a page is open it answers Back, and an erase, here or on another device,
  // closes it and drops what it held (US-16 AC2a).
  useEffect(() => {
    if (!open) return;
    const onPop = () => {
      // A page left open on My data while another tab shows does not answer Back.
      if (onPageEntry() || panelRef.current?.closest('[hidden]')) return;
      // Settings cover the page: Back closes them (HealthTool), and the page keeps its entry.
      if (panelRef.current?.querySelector('.mh-page-host[hidden]')) { pushPageEntry(); return; }
      // Back from a page holding typed input, declined: stay, and keep the entry.
      if (!mayLeave()) { pushPageEntry(); return; }
      finishClose(open.from);
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener(DRAFTS_CLEARED_EVENT, drop);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener(DRAFTS_CLEARED_EVENT, drop);
    };
  }, [open]);
  const [sayPanel, panelMessages] = useLiveRegion('md-panel-messages');
  // A chat edit closes any open page, so the field it filled shows (US-16 AC2).
  // Read as the reveal renders: the page unmounts in this commit, and its form clears the mark as it goes.
  const revealDropsTyping = revealing && !!open && pageDirty.current;
  useEffect(() => {
    if (!revealing || !open) return;
    if (revealDropsTyping) sayPanel(TYPED_NOT_SAVED);
    drop();
  }, [revealing]);

  return { pageShown, tableShown, openPage, switchPage, closePage, showTable, pageDirty, panelMessages };
}
