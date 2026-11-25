// @vitest-environment jsdom
/**
 * US-15 AC77: the tool page's entry (standalone/app.tsx) reads the store's
 * chat posture from its root's `data-surface`, so every chat on the tool page (the panel beside the tool and its pop-up)
 * takes that posture's words from the one table. Runs the real page entry on an empty device record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/sentry', () => ({ initSentry: vi.fn(), Sentry: { captureException: vi.fn(), captureMessage: vi.fn() } }));
vi.mock('../src/lib/server-api', async (importOriginal) => ({ ...(await importOriginal<object>()), trackProductEvent: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network forbidden in this test'); }));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.innerHTML = ''; });

describe('US-15 AC77: the tool page\'s chat panel reads the store\'s posture', () => {
  it.each([
    ['brand', 'Synthetic Shop chat'],
    ['doctor', 'Health by Dr Brad Chat'],
  ])('%s store → the chat is named "%s"', async (surface, label) => {
    document.body.innerHTML = `<div id="health-tool-root" data-surface="${surface}" data-assistant-name="Synthetic Shop"><p>skeleton</p></div>`;
    await import('./app');
    const root = document.getElementById('health-tool-root')!;
    await vi.waitFor(() => expect(root.textContent).not.toBe('skeleton'), { timeout: 8000 }); // the app has rendered
    const { getChatSurface } = await import('../src/lib/assistant-config');
    const { chatCopy } = await import('../src/components/chat-copy');
    expect(getChatSurface()).toBe(surface);
    expect(chatCopy().label).toBe(label);
  });
});
