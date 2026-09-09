import {useLayoutEffect, useRef, useState} from 'react';
import {interpolate, Easing, delayRender, continueRender} from 'remotion';

/**
 * Analytic chat scroll from measured block geometry. Every block is always in the
 * DOM and only animates opacity/transform, so heights are static and one
 * measurement after mount is enough. Mirrors the logic in ApobDemo.
 */
export const useChatScroll = (order: string[], cue: Record<string, number>, frame: number, viewH: number, keepH: number) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const refs = useRef<Record<string, HTMLDivElement | null>>({});
  const [box, setBox] = useState<Record<string, {top: number; h: number}> | null>(null);
  const [handle] = useState(() => delayRender('measure chat layout'));

  useLayoutEffect(() => {
    if (!contentRef.current) return;
    const next: Record<string, {top: number; h: number}> = {};
    for (const key of order) {
      const el = refs.current[key];
      if (el) next[key] = {top: el.offsetTop, h: el.offsetHeight};
    }
    setBox(next);
    continueRender(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle]);

  let scroll = 0;
  if (box) {
    const contentH = contentRef.current?.scrollHeight ?? 0;
    const maxScroll = Math.max(0, contentH - viewH);
    const targetOf = (k: string) => {
      const b = box[k];
      if (!b) return 0;
      const t = b.h > keepH - 40 ? b.top - 16 : b.top + b.h + 28 - keepH;
      return Math.min(maxScroll, Math.max(0, t));
    };
    const cues = order.filter((k) => frame >= cue[k]);
    const k = cues.length - 1;
    if (k >= 0) {
      const from = k === 0 ? 0 : targetOf(order[k - 1]);
      const to = targetOf(order[k]);
      const start = cue[order[k]];
      scroll = interpolate(frame, [start, start + 22], [from, to], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: Easing.bezier(0.33, 0, 0.15, 1),
      });
    }
  }
  const set = (k: string) => (el: HTMLDivElement | null) => {
    refs.current[k] = el;
  };
  return {contentRef, set, box, scroll};
};
