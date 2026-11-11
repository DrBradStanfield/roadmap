/** Whether the browser says it is offline, kept current by its online and
 *  offline events. Split from useChatState (file budget). */
import { useEffect, useState } from 'react';

export function useOffline(): boolean {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const off = () => setIsOffline(true);
    const on = () => setIsOffline(false);
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => { window.removeEventListener('offline', off); window.removeEventListener('online', on); };
  }, []);
  return isOffline;
}
