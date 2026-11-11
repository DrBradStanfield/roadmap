// @vitest-environment jsdom
/**
 * US-62 AC30e: the supplement search chooses on the touch itself. On an iPhone
 * a tap on "Creatine" in the list added nothing: the mouse events WebKit makes
 * after a touch can land on another element, so the list closed and the
 * option's click never ran. Rendered whole over a real RoadmapStore on jsdom's
 * localStorage, with synthetic records only.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { seedGuest, useHealthToolLifecycle } from '../testing/health-tool-harness';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async importOriginal => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(), trackABImpression: vi.fn(), trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));

import { HealthTool } from './HealthTool';

useHealthToolLifecycle();

async function open() {
  await seedGuest({ sex: 'male', heightCm: 178, birthYear: 1980, birthMonth: 1 }, [['weight', 80]]);
  const view = render(<HealthTool />);
  const add = await waitFor(() => view.getByRole('button', { name: '+ Add another supplement' }));
  const box = add.closest<HTMLElement>('.supplement-add')!;
  const row = () => within(box).queryByRole('button', { name: '+ Add another supplement' });
  const search = () => box.querySelector<HTMLInputElement>('input');
  const option = (name: string) => [...box.querySelectorAll<HTMLElement>('.supplement-dropdown-item')].find(b => b.textContent === name);
  const names = () => [...view.container.querySelectorAll('.supplement-name')].map(n => n.textContent);
  fireEvent.click(add);
  return { view, row, search, option, names };
}

/** A finger's tap as WebKit sends it: pointer and touch events, on the element under the finger. */
function tap(el: Element) {
  fireEvent.pointerDown(el, { pointerType: 'touch', isPrimary: true });
  fireEvent.touchStart(el, { touches: [{ clientX: 1, clientY: 1 }] });
  fireEvent.pointerUp(el, { pointerType: 'touch', isPrimary: true });
  return fireEvent.touchEnd(el, { changedTouches: [{ clientX: 1, clientY: 1 }] });
}

describe('US-62 AC30e: the supplement search on a touch screen', () => {
  it('a tap on an option adds it from the touch, and stops the mouse events that would land elsewhere', async () => {
    const { search, option, row, names } = await open();
    fireEvent.change(search()!, { target: { value: 'Creatine' } });
    // touchend default-prevented: the browser sends no mousedown or click after it,
    // so nothing lands on whatever WebKit's tap adjustment or a shifting page puts there.
    expect(tap(option('Creatine')!)).toBe(false);
    expect(names()).toContain('Creatine');
    expect(search()).toBeNull();
    expect(document.activeElement).toBe(row()); // AC30c: the focus back on the row
  });

  it('AC30g: a press on the empty search\'s list that blurs the search first still adds (real iPhone)', async () => {
    // On a real iPhone the search lost the focus before the tap's click; an empty search
    // closed on that blur, the card below moved up under the finger and took the click.
    for (const pointerType of ['mouse', 'touch'] as const) {
      const { option, names, view } = await open();
      const creatine = option('Creatine')!;
      fireEvent.pointerDown(creatine, { pointerType, isPrimary: true });
      fireEvent.blur(view.container.querySelector('.supplement-add input')!, { relatedTarget: null });
      expect(view.container.querySelector('.supplement-dropdown')).not.toBeNull(); // still there to be tapped
      if (pointerType === 'touch') fireEvent.touchEnd(creatine, { changedTouches: [{ clientX: 1, clientY: 1 }] });
      else fireEvent.click(creatine);
      expect(names()).toContain('Creatine');
      view.unmount();
      localStorage.clear();
    }
  });

  it('a touch that scrolls the list (pointercancel) adds nothing', async () => {
    const { option, names, search } = await open();
    const first = option('Creatine')!;
    fireEvent.pointerDown(first, { pointerType: 'touch', isPrimary: true });
    fireEvent.touchStart(first);
    fireEvent.pointerCancel(first, { pointerType: 'touch', isPrimary: true });
    fireEvent.touchEnd(first);
    expect(names()).not.toContain('Creatine');
    expect(search()).not.toBeNull();
  });

  it('a press outside closes the list on pointerdown, where the target is the one under the finger', async () => {
    const { view, search } = await open();
    fireEvent.change(search()!, { target: { value: 'Crea' } });
    expect(view.container.querySelector('.supplement-dropdown')).not.toBeNull();
    fireEvent.pointerDown(document.body, { pointerType: 'touch', isPrimary: true });
    expect(view.container.querySelector('.supplement-dropdown')).toBeNull();
    expect(search()!.value).toBe('Crea'); // something typed stays open (AC30c)
  });

  it('Return in the search adds the exact match, else the first option, else the typed name', async () => {
    const s = await open();
    fireEvent.change(s.search()!, { target: { value: 'creatine' } });
    fireEvent.keyDown(s.search()!, { key: 'Enter' });
    expect(s.names()).toContain('Creatine');
    expect(document.activeElement).toBe(s.row());

    fireEvent.click(s.row()!);
    fireEvent.change(s.search()!, { target: { value: 'Magnes' } });
    fireEvent.keyDown(s.search()!, { key: 'Enter' });
    expect(s.names()).toContain('Magnesium');

    fireEvent.click(s.row()!);
    fireEvent.change(s.search()!, { target: { value: 'Zz test powder' } });
    fireEvent.keyDown(s.search()!, { key: 'Enter' });
    expect(s.names()).toContain('Zz test powder');

    // An empty search adds nothing.
    fireEvent.click(s.row()!);
    fireEvent.keyDown(s.search()!, { key: 'Enter' });
    expect(s.search()).not.toBeNull();
  });
});
