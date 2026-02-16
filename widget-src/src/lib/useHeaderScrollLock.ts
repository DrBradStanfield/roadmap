import { useState, useEffect, type RefObject } from 'react';

/**
 * Returns true when the header is visible (any part in viewport).
 * Used to lock panel overflow so page scrolls first to push the header away.
 */
export function useHeaderScrollLock(
  headerRef: RefObject<HTMLDivElement | null>,
  isMobile: boolean,
): boolean {
  const [headerVisible, setHeaderVisible] = useState(true);

  useEffect(() => {
    if (isMobile) {
      setHeaderVisible(false);
      return;
    }

    const header = headerRef.current;
    if (!header) return;

    const container = header.parentElement;

    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = entry.isIntersecting;
        setHeaderVisible(visible);
        if (container) {
          const grid = container.querySelector('.health-tool-content');
          const gridTop = visible && grid ? Math.max(0, grid.getBoundingClientRect().top) : 0;
          container.style.setProperty('--header-height', `${gridTop}px`);
        }
      },
      { threshold: 0 },
    );

    observer.observe(header);
    return () => observer.disconnect();
  }, [headerRef, isMobile]);

  return headerVisible;
}
