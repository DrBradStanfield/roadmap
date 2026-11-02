import { flushRoadmapStoreSync } from '../src/lib/roadmap-data';

/** Register the entrypoint's synchronous save before the component listeners. */
export function registerPageDeparture(onHidden: () => void): () => void {
  const hidden = () => {
    if (document.visibilityState !== 'hidden') return;
    flushRoadmapStoreSync();
    onHidden();
  };
  document.addEventListener('visibilitychange', hidden);
  window.addEventListener('beforeunload', flushRoadmapStoreSync);
  return () => {
    document.removeEventListener('visibilitychange', hidden);
    window.removeEventListener('beforeunload', flushRoadmapStoreSync);
  };
}
