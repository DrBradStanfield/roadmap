import { useState, useEffect } from 'react';

export function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia(query).matches
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

export function useIsMobile(breakpoint = 768): boolean {
  return useMatchMedia(`(max-width: ${breakpoint}px)`);
}

export function useIsWideDesktop(minWidth = 1200): boolean {
  return useMatchMedia(`(min-width: ${minWidth}px)`);
}
