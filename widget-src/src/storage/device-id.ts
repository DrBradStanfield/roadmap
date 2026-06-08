/**
 * A stable per-device id, persisted in localStorage. Used by the merge logic as
 * the `lastDeviceId` author stamp and tie-break. It is NOT an account id — the
 * user's cloud account is their identity (implementation plan §5.2). If
 * localStorage is wiped, a new device id is minted; that's fine (merge stays
 * correct, it's only a tie-break).
 */
const DEVICE_ID_KEY = 'health_roadmap_device_id';

export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
  } catch {
    /* sandboxed iframe — fall through to an ephemeral id */
  }
  const id = `dev_${shortRandom()}`;
  try {
    localStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    /* best effort */
  }
  return id;
}

function shortRandom(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  }
  return Math.random().toString(36).slice(2, 12);
}
