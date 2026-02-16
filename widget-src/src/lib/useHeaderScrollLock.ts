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

    const observer = new IntersectionObserver(
      ([entry]) => setHeaderVisible(entry.isIntersecting),
      { threshold: 0 },
    );

    observer.observe(header);
    return () => observer.disconnect();
  }, [headerRef, isMobile]);

  return headerVisible;
}
