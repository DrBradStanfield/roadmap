// About you's move to the foot of My health (US-62 AC12): when the focus has
// left its card, and the FLIP that carries it there. Split from InputPanel.tsx
// (W1-2, US-64).
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { PanelOnboarding } from './useOnboarding';

export function useAboutCardMove(aboutYouLow: boolean, onProfileLeft: PanelOnboarding['profileLeft'], panelRef: RefObject<HTMLDivElement | null>) {
  // About you sits low, as on the iPhone, phone and desktop (US-62 AC12): for
  // a record complete when first shown, and once the onboarding's four answers
  // hold and the focus leaves its card, never mid-typing. The card travels to
  // the foot (FLIP: each card measured before, then animated from there, by
  // transform only) while its rows fade in; the cards below slide up, so the
  // next card takes its place on screen. Reduced motion moves it at once.
  const aboutRef = useRef<HTMLDivElement>(null);
  const flipFrom = useRef<Map<Element, number> | null>(null);
  // A press inside the card is not leaving it: Safari gives a focusout with
  // no next target for a click on a button (Male, the unit pill) or on text.
  // Such a press leaves nothing focused, so the next press or focus outside
  // the card is the leaving (N4); focus back inside the card cancels it.
  const pressedInside = useRef(false);
  const leavePending = useRef(false);
  const leaveCard = () => {
    leavePending.current = false;
    // Measured only for a move (HealthTool's call), still before it: React commits the move after this handler returns.
    if (!onProfileLeft?.()) return;
    flipFrom.current = new Map([...(panelRef.current?.children ?? [])].map(el => [el, el.getBoundingClientRect().top]));
  };
  const leaveProfile = (e: React.FocusEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    if (!e.relatedTarget && pressedInside.current) { leavePending.current = true; return; }
    leaveCard();
  };
  useEffect(() => {
    if (aboutYouLow) return;
    const outside = (e: Event) => {
      if (leavePending.current && !aboutRef.current?.contains(e.target as Node)) leaveCard();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside, true);
    };
  });
  useLayoutEffect(() => {
    const from = flipFrom.current;
    flipFrom.current = null;
    if (!from || !aboutYouLow || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    // The cards below ease out as they rise; About you eases in too, so its
    // first steps down are seen before it travels out of view.
    const rise = { duration: 400, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' };
    const travel = { duration: 450, easing: 'cubic-bezier(0.45, 0, 0.2, 1)' };
    for (const el of panelRef.current?.children ?? []) {
      const top = from.get(el);
      const dy = top === undefined ? 0 : top - el.getBoundingClientRect().top;
      if (Math.abs(dy) >= 1) el.animate?.([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], el === aboutRef.current ? travel : rise);
    }
    aboutRef.current?.querySelector('.prefill-fields-wrapper')?.animate?.([{ opacity: 0 }, { opacity: 1 }], travel);
  }, [aboutYouLow]);
  return { aboutRef, pressedInside, leavePending, leaveProfile };
}
