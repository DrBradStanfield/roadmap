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
// The table is a separate toggle beside it, not a third state: showTable opens
// and closes it, and a chat edit to a grid cell shows it too.
// A page is a history entry (a state marker, no URL change), so the phone's
// back gesture closes it. Typed, unsaved input is not dropped silently:
// leaving asks first, and a chat reveal that drops it says so. An erase
// drops it as it drops everything else (US-16 AC2a).
import { useEffect, useRef, useState, type RefObject } from 'react';
import { DRAFTS_CLEARED_EVENT } from './storage';
import { useLiveRegion } from '../components/BloodTestTimeline';
import type { ValueSubject } from '../components/MyDataRows';

/** The history-state key a phone value page's entry carries (US-62 AC10). */
const VALUE_PAGE_STATE = 'hrValuePage';
const LEAVE_UNSAVED = 'Leave without saving the value you typed?';
/** Said when a chat edit closes a page that held typed input. */
const TYPED_NOT_SAVED = 'Your typed value was not saved.';

/** The field a chat edit filled, for My data to show (US-16 AC2). */
export type RevealCell = { field: string; grid: boolean } | null;

const onPageEntry = () => !!window.history.state?.[VALUE_PAGE_STATE];
const pushPageEntry = () => window.history.pushState({ ...window.history.state, [VALUE_PAGE_STATE]: true }, '');

export function useValuePage(revealCell: RevealCell, panelRef: RefObject<HTMLDivElement | null>) {
  const [valuePage, setValuePage] = useState<ValueSubject | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const [seenReveal, setSeenReveal] = useState<RevealCell>(null);
  // A chat reveal closes the value page; only a filled grid cell opens the table (adversary R6).
  const revealing = !!revealCell && revealCell !== seenReveal;
  const tableShown = tableOpen || (revealing && revealCell.grid);
  const pageShown = !revealing ? valuePage : null;
  const cameFrom = useRef<{ el: Element | null; y: number }>({ el: null, y: 0 });
  /** Set by the open page's form while it holds typed, unsaved input. */
  const pageDirty = useRef(false);
  const valuePageRef = useRef(valuePage);
  valuePageRef.current = valuePage;
  const mayLeave = () => !pageDirty.current || window.confirm(LEAVE_UNSAVED);

  // `from` is the row pressed: WebKit does not focus a button on a tap, so the active element is stale.
  const openPage = (subject: ValueSubject, from?: Element) => {
    cameFrom.current = { el: from ?? document.activeElement, y: window.scrollY };
    setSeenReveal(revealCell);
    setValuePage(subject);
    if (!onPageEntry()) pushPageEntry();
  };
  /** From one page to another: asks first if the page holds typed input. */
  const switchPage = (subject: ValueSubject) => { if (mayLeave()) openPage(subject); };
  /** Back to the rows, the focus on the row the page opened from. */
  const finishClose = () => {
    pageDirty.current = false;
    setValuePage(null);
    requestAnimationFrame(() => {
      const { el, y } = cameFrom.current;
      if (el instanceof HTMLElement && el.isConnected) {
        el.scrollIntoView({ behavior: 'instant', block: 'center' });
        el.focus({ preventScroll: true });
      } else window.scrollTo?.({ top: y, behavior: 'instant' });
    });
  };
  /** Closed from outside (an erase, a chat reveal): what it held goes, with its entry. */
  const drop = () => {
    setValuePage(null);
    pageDirty.current = false;
    if (onPageEntry()) window.history.back();
  };
  // "‹ My data": goes back, so its popstate closes the page.
  const closePage = () => {
    if (!mayLeave()) return;
    pageDirty.current = false;
    if (onPageEntry()) window.history.back();
    else finishClose();
  };
  const showTable = (open: boolean) => { setSeenReveal(revealCell); setTableOpen(open); };
  // A grid mounted hidden never scrolled to its newest column: do it on showing.
  // The vitals grid's range ends on a whole column (styles.css, H105); where it ends past New
  // (a 320 phone), it opens with New whole beside the names, and a swipe brings Trend.
  useEffect(() => {
    if (!tableShown) return;
    panelRef.current?.querySelectorAll<HTMLElement>('.md-table .bt-timeline-scroll').forEach(el => {
      el.scrollLeft = el.scrollWidth;
      const newCol = el.closest('.bt-vitals-card') && el.querySelector('.bt-header-row .bt-cell-draft-date');
      const names = el.querySelector('.bt-header-row .bt-cell-name');
      if (newCol && names) el.scrollLeft += Math.min(0, newCol.getBoundingClientRect().left - names.getBoundingClientRect().right);
    });
  }, [tableShown]);
  // A focused vitals cell shows whole: WebKit centres a focused input, and the snap then rounds
  // to the nearer column, which can cut its cell. So a cut cell moves beside the names (H105).
  useEffect(() => {
    const onFocus = (e: FocusEvent) => requestAnimationFrame(() => {
      const at = e.target as Element;
      const cell = panelRef.current?.contains(at) ? at.closest('.md-table .bt-vitals-card .bt-cell-value') : null;
      const el = cell?.closest('.bt-timeline-scroll');
      const [names, trend] = ['name', 'trend'].map(c => el?.querySelector(`.bt-header-row .bt-cell-${c}`)?.getBoundingClientRect());
      if (!cell || !el || !names || !trend) return;
      const box = cell.getBoundingClientRect(), right = Math.min(el.getBoundingClientRect().right, trend.left);
      if (box.left < names.right - 1 || box.right > right + 1) el.scrollLeft += box.left - names.right;
    });
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, []);

  // A reload on a page's entry opens on the rows: drop the stale marker, so the next page pushes its own.
  useEffect(() => {
    if (onPageEntry()) window.history.replaceState({ ...window.history.state, [VALUE_PAGE_STATE]: undefined }, '');
  }, []);
  useEffect(() => {
    if (!valuePage) return;
    const onPop = () => {
      // A page left open on My data while another tab shows does not answer Back.
      if (onPageEntry() || panelRef.current?.closest('[hidden]')) return;
      // Settings cover the page: Back closes them (HealthTool), and the page keeps its entry.
      if (panelRef.current?.querySelector('.mh-page-host[hidden]')) { pushPageEntry(); return; }
      // Back from a page holding typed input, declined: stay, and keep the entry.
      if (!mayLeave()) { pushPageEntry(); return; }
      finishClose();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [valuePage]);
  // An erase, here or on another device, closes an open page and drops what it held (US-16 AC2a).
  useEffect(() => {
    const onErase = () => { if (valuePageRef.current) drop(); };
    window.addEventListener(DRAFTS_CLEARED_EVENT, onErase);
    return () => window.removeEventListener(DRAFTS_CLEARED_EVENT, onErase);
  }, []);
  const [sayPanel, panelMessages] = useLiveRegion('md-panel-messages');
  // A chat edit closes any open page, so the field it filled shows (US-16 AC2).
  // Read as the reveal renders: the page unmounts in this commit, and its form clears the mark as it goes.
  const revealDropsTyping = useRef(false);
  if (revealing && valuePage && pageDirty.current) revealDropsTyping.current = true;
  useEffect(() => {
    if (!revealing || !valuePage) return;
    if (revealDropsTyping.current) sayPanel(TYPED_NOT_SAVED);
    revealDropsTyping.current = false;
    drop();
  }, [revealing]);

  return { pageShown, tableShown, openPage, switchPage, closePage, showTable, pageDirty, panelMessages };
}
