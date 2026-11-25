// @vitest-environment jsdom
/**
 * US-74 review C10, C9: the widgets' entry over the real shared boot(). A
 * widget whose record cannot open says so in its own block, never in the full
 * app's root on the same page; and the entry waits for the page's markup.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { StorageError } from '@roadmap/health-core/adapter';
import { LocalStorageAdapter } from '../src/storage/local-storage-adapter';

vi.mock('./resolve-backend', () => ({ resolveBackend: vi.fn(async () => ({ resolved: { adapter: new LocalStorageAdapter(), backend: 'local' } })) }));
vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: vi.fn() }, initSentry: vi.fn() }));
vi.mock('../src/lib/roadmap-data', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/roadmap-data')>(),
  initRoadmapStore: vi.fn(async () => { throw new StorageError('The saved record could not be read', 'local', undefined, undefined, undefined, 'no-answer'); }),
}));

// The full app's failure panel, which renders into #health-tool-root: the widgets must never call it.
const fullAppPanel = vi.hoisted(() => vi.fn((error: unknown) => { throw error; }));
vi.mock('./load-failure', async (importOriginal) => ({
  ...await importOriginal<typeof import('./load-failure')>(),
  showLoadFailure: fullAppPanel,
}));

import { startWidgets, whenReady } from './widgets';

afterEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as Record<symbol, unknown>)[Symbol.for('health-widgets.started')];
});

describe('single-topic widget entry over the real boot (US-74)', () => {
  it('C10: a storage failure at boot shows in the widget block, and leaves the full app\'s root alone', async () => {
    document.body.innerHTML = '<div id="health-tool-root"><p>full app</p></div><div class="hr-widget" data-widget="waist-to-height">&nbsp;</div>';
    await act(async () => { await startWidgets(); await new Promise((r) => setTimeout(r, 50)); });
    expect(fullAppPanel).not.toHaveBeenCalled();
    expect(document.getElementById('health-tool-root')!.innerHTML).toBe('<p>full app</p>');
    const block = document.querySelector('.hr-widget')!;
    expect(block.querySelector('[role="alert"] h3')?.textContent).toBe('Your saved record did not load');
    expect(block.textContent).toContain('The saved record could not be read'); // the storage failure itself reached the block
    expect(block.innerHTML).not.toMatch(/Dr Brad|drstanfield|mailto/i);
  });

  it('C9: waits for the page\'s markup when the script runs before it, and starts at once after', () => {
    const listeners: Array<() => void> = [];
    const loading = { readyState: 'loading', addEventListener: (_: string, fn: () => void) => listeners.push(fn) } as unknown as Document;
    const start = vi.fn();
    whenReady(start, loading);
    expect(start).not.toHaveBeenCalled();
    listeners.forEach((fn) => fn());
    expect(start).toHaveBeenCalledTimes(1);
    whenReady(start, { readyState: 'interactive' } as Document);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
