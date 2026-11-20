import { useRef } from 'react';

/** The same array while its items are the same (by identity): a memo keyed on it rebuilds only when an item changes. */
export function useStable<T>(items: readonly T[]): readonly T[] {
  const kept = useRef(items);
  if (items.length !== kept.current.length || items.some((x, i) => x !== kept.current[i])) kept.current = items;
  return kept.current;
}
