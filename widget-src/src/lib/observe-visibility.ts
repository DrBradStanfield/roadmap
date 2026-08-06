/**
 * Watch an element's viewport visibility, degrading gracefully where
 * IntersectionObserver is unavailable — iOS/macOS Lockdown Mode removes the
 * API entirely, and a bare `new IntersectionObserver(...)` crashed the whole
 * site-chat React tree ("Can't find variable: IntersectionObserver",
 * Sentry 7625508570). Without the API the element is reported as immediately
 * visible, so lazy-loaded content still loads and scroll-driven behaviour
 * stays permanently active instead of crashing.
 *
 * Returns a cleanup function.
 */
export function observeVisibility(
  el: Element,
  onChange: (visible: boolean) => void,
  options?: IntersectionObserverInit,
): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    onChange(true);
    return () => {};
  }
  const observer = new IntersectionObserver(
    entries => onChange(entries.some(e => e.isIntersecting)),
    options,
  );
  observer.observe(el);
  return () => observer.disconnect();
}
