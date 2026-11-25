// @vitest-environment jsdom
/**
 * US-11 AC14: the page's forget door and the crash screen's are one call,
 * clearOffFileAfterErase, which also clears the device's record mirror (the
 * legacy v1 key) and the authenticated flag, with or without a record open.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { clearOffFileAfterErase } from './roadmap-data';
import { MIRROR_KEY } from './storage';

afterEach(() => localStorage.clear());

describe('US-11 AC14: clearOffFileAfterErase', () => {
  it('clears the device record mirror and the authenticated flag, and leaves other keys', () => {
    localStorage.setItem(MIRROR_KEY, JSON.stringify({ inputs: { heightCm: 180 } }));
    localStorage.setItem('health_roadmap_authenticated', 'true');
    localStorage.setItem('health_roadmap_backend', 'dropbox');
    clearOffFileAfterErase();
    expect(localStorage.getItem(MIRROR_KEY)).toBeNull();
    expect(localStorage.getItem('health_roadmap_authenticated')).toBeNull();
    expect(localStorage.getItem('health_roadmap_backend')).toBe('dropbox');
  });
});
