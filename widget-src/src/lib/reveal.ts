/** Scroll an element into view and move the focus to it, without a second jump:
 *  a pill's section, the banner's card, the page's title (US-62 AC17, AC19, AC25). */
export function revealAndFocus(el: HTMLElement | null | undefined, block: ScrollLogicalPosition, smooth = true): void {
  el?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block });
  el?.focus({ preventScroll: true });
}
