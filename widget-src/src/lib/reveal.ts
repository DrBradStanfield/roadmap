/**
 * How far the storefront's own sticky or fixed bar (the theme's header) reaches
 * down the viewport, in px; 0 when there is none (localhost, Pages). Read at the
 * moment of a jump: a theme's header can hide or grow as the page scrolls.
 */
export function stickyTop(): number {
  let bottom = 0;
  for (const hit of document.elementsFromPoint?.(window.innerWidth / 2, 1) ?? []) {
    for (let el: Element | null = hit; el && el !== document.body && !el.matches('.health-tool'); el = el.parentElement) {
      const { position } = getComputedStyle(el);
      if (position === 'fixed' || position === 'sticky') { bottom = Math.max(bottom, el.getBoundingClientRect().bottom); break; }
    }
  }
  return Math.max(0, Math.round(bottom));
}

/** Scroll an element to the top of the viewport, clear of the theme's sticky header, 12px below it. */
export function scrollToTop(el: HTMLElement | null | undefined, smooth = false): void {
  if (!el) return;
  el.style.scrollMarginTop = `${stickyTop() + 12}px`;
  el.scrollIntoView?.({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
}

/** Scroll an element into view and move the focus to it, without a second jump:
 *  a pill's section, the banner's card, the page's title (US-62 AC17, AC19, AC25),
 *  never under the theme's sticky header. */
export function revealAndFocus(el: HTMLElement | null | undefined, block: ScrollLogicalPosition, smooth = true): void {
  if (el) el.style.scrollMarginTop = `${stickyTop() + 12}px`;
  el?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block });
  el?.focus({ preventScroll: true });
}
