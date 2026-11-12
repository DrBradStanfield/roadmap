/**
 * A random id in UUID form, never derived from an account. crypto.randomUUID
 * is missing before Safari 15.4 and outside a secure context; then a v4 UUID
 * is built from crypto.getRandomValues. With neither, a counter and the clock.
 */
let fallbackCount = 0;

export function randomId(): string {
  const c = typeof crypto === 'undefined' ? undefined : crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  if (typeof c?.getRandomValues === 'function') {
    return Array.from(c.getRandomValues(new Uint8Array(16)))
      .map((b, i) => {
        if (i === 6) b = (b & 0x0f) | 0x40; // version 4
        if (i === 8) b = (b & 0x3f) | 0x80; // variant 1
        return b.toString(16).padStart(2, '0');
      })
      .join('')
      .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
  }
  fallbackCount += 1;
  return `${Date.now().toString(36)}-${fallbackCount.toString(36)}`;
}
