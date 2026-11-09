// My data's view state (US-62 AC10, AC11): which value page is open, whether
// the grids show as a table, and the browser history entry a page owns.
//
// The machine, in one place:
//   rows ──open──▶ page(subject) ──open──▶ page(other subject)   (asks first if typed)
//   page ──close / Back──▶ rows, focus back on the row it opened from
//   page ──erase / chat reveal──▶ rows (drop: no focus return)
//   rows ⇄ table (showTable); a chat edit to a grid cell shows the table too.
// A page is a history entry (a state marker, no URL change), so the phone's
// back gesture closes it. Typed, unsaved input is never dropped silently:
// leaving asks first, and a chat reveal that drops it says so.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { DRAFTS_CLEARED_EVENT } from './storage';
import { useLiveRegion } from '../components/BloodTestTimeline';
import type { ValueSubject } from '../components/MyDataRows';

/** The history-state key a phone value page's entry carries (US-62 AC10). */
const VALUE_PAGE_STATE = 'hrValuePage';
const LEAVE_UNSAVED = 'Leave without saving the value you typed?';
/** Said when a chat edit closes a page that held typed input. */
const TYPED_NOT_SAVED = 'Your typed value was not saved.';

type RevealCell = { field: string; grid: boolean } | null;

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
  useEffect(() => {
    if (!tableShown) return;
    panelRef.current?.querySelectorAll<HTMLElement>('.md-table .bt-timeline-scroll').forEach(el => { el.scrollLeft = el.scrollWidth; });
  }, [tableShown]);

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
  // A chat edit closes any open page, so the field it filled shows (US-16 AC2).
  const [sayPanel, panelMessages] = useLiveRegion('md-panel-messages');
  // Read as the reveal renders: the page unmounts in this commit, and its form clears the mark as it goes.
  const revealDropsTyping = useRef(false);
  if (revealing && valuePage && pageDirty.current) revealDropsTyping.current = true;
  useEffect(() => {
    if (!revealing || !valuePage) return;
    if (revealDropsTyping.current) sayPanel(TYPED_NOT_SAVED);
    revealDropsTyping.current = false;
    drop();
  }, [revealing]);

  return { pageShown, tableShown, openPage, closePage, mayLeave, showTable, pageDirty, panelMessages };
}
