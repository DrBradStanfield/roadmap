// The plan's new-card glow (US-07 AC3): which suggestions glow, and which fade.
import { useEffect, useRef, useState } from 'react';
import type { Suggestion } from '@roadmap/health-core/types';
import { NO_HIGHLIGHTS, type Highlights } from '../components/PlanCards';

type Glow = { phase: 'still' } | { phase: 'glowing'; ids: Set<string> } | { phase: 'fading'; ids: Set<string> };
const STILL: Glow = { phase: 'still' };

/**
 * New or changed suggestions glow for 3 s, then fade for 0.5 s.
 * - Settling, the first 3 s after mount: nothing glows; each plan becomes the baseline.
 *   So does the first batch after an empty baseline.
 * - still → glowing(ids): a plan with ids new or reworded against the baseline.
 * - glowing → fading(ids) after 3 s; fading → still after 0.5 s, and the plan becomes the baseline.
 * - glowing or fading → glowing(ids): another plan with ids new against the baseline restarts it.
 * - glowing or fading → still: a plan with nothing new (a change undone) ends it at once.
 * The settle flag and the baseline never render, so they are refs.
 */
export function useHighlights(suggestions: Suggestion[] | undefined): Highlights {
  const [glow, setGlow] = useState<Glow>(STILL);
  const baselineRef = useRef<Map<string, { title: string; description: string }>>(new Map());
  const settledRef = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => { settledRef.current = true; }, 3000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const current = suggestions ?? [];
    const currentMap = new Map(current.map(s => [s.id, { title: s.title, description: s.description }]));
    if (!settledRef.current || (baselineRef.current.size === 0 && currentMap.size > 0)) {
      baselineRef.current = currentMap;
      return;
    }
    const ids = new Set<string>();
    for (const s of current) {
      const prev = baselineRef.current.get(s.id);
      if (!prev || prev.title !== s.title || prev.description !== s.description) ids.add(s.id);
    }
    if (ids.size === 0) {
      setGlow(STILL); // the same object: no re-render when already still
      baselineRef.current = currentMap;
      return;
    }
    setGlow({ phase: 'glowing', ids });
    let fadeTimer: ReturnType<typeof setTimeout> | undefined;
    const glowTimer = setTimeout(() => {
      setGlow({ phase: 'fading', ids });
      fadeTimer = setTimeout(() => {
        setGlow(STILL);
        baselineRef.current = currentMap;
      }, 500);
    }, 3000);
    return () => { clearTimeout(glowTimer); clearTimeout(fadeTimer); };
  }, [suggestions]);

  return {
    highlighted: glow.phase === 'glowing' ? glow.ids : NO_HIGHLIGHTS,
    fadingOut: glow.phase === 'fading' ? glow.ids : NO_HIGHLIGHTS,
  };
}
