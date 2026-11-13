// @vitest-environment jsdom
/**
 * US-62 AC30c, AC30e, AC30g: pins on how "+ Add another supplement" moves
 * between the row and its open search, written against main before its mode
 * became one named state (lib/supplement-add.ts). Each case is a path the
 * other suites leave open: what releases a held press, and what an outside
 * press, a focus and a keystroke do to the list. Rendered whole over a real
 * RoadmapStore on jsdom's localStorage, with synthetic records only.
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
  const list = () => box.querySelector('.supplement-dropdown');
  const option = (name: string) => [...box.querySelectorAll<HTMLElement>('.supplement-dropdown-item')].find(b => b.textContent === name);
  const names = () => [...view.container.querySelectorAll('.supplement-name')].map(n => n.textContent);
  const leave = () => fireEvent.blur(search()!, { relatedTarget: null });
  fireEvent.click(add);
  return { box, row, search, list, option, names, leave };
}

describe('US-62 AC30c, AC30g: the add row and its search, pinned before the union', () => {
  it('opens with the search focused and its list shown', async () => {
    const s = await open();
    expect(document.activeElement).toBe(s.search());
    expect(s.list()).not.toBeNull();
    expect(s.row()).toBeNull();
  });

  it('a press held on the list keeps an empty search open on blur; a pointercancel releases it', async () => {
    const s = await open();
    fireEvent.pointerDown(s.option('Creatine')!, { pointerType: 'touch', isPrimary: true });
    s.leave();
    expect(s.search()).not.toBeNull();
    fireEvent.pointerCancel(s.option('Creatine')!, { pointerType: 'touch', isPrimary: true });
    s.leave();
    expect(s.search()).toBeNull();
    expect(s.row()).not.toBeNull();
  });

  it('a press outside releases a held press: the empty search then closes on blur', async () => {
    const s = await open();
    fireEvent.pointerDown(s.option('Creatine')!, { pointerType: 'mouse', isPrimary: true });
    fireEvent.pointerDown(document.body, { pointerType: 'mouse', isPrimary: true });
    expect(s.list()).toBeNull();
    expect(s.search()).not.toBeNull();
    s.leave();
    expect(s.search()).toBeNull();
  });

  it('a press held on the list does not outlive the search: Escape, reopen, and an empty blur closes it', async () => {
    const s = await open();
    fireEvent.pointerDown(s.option('Creatine')!, { pointerType: 'mouse', isPrimary: true });
    fireEvent.keyDown(s.search()!, { key: 'Escape' });
    expect(document.activeElement).toBe(s.row());
    fireEvent.click(s.row()!);
    s.leave();
    expect(s.search()).toBeNull();
  });

  it('text typed keeps the search open when left, its list still shown', async () => {
    const s = await open();
    fireEvent.change(s.search()!, { target: { value: 'Crea' } });
    s.leave();
    expect(s.search()!.value).toBe('Crea');
    expect(s.list()).not.toBeNull(); // a blur alone never hides the list
  });

  it('after a press outside hides the list, typing or a focus shows it again', async () => {
    const s = await open();
    fireEvent.change(s.search()!, { target: { value: 'Crea' } });
    fireEvent.pointerDown(document.body, { pointerType: 'touch', isPrimary: true });
    expect(s.list()).toBeNull();
    fireEvent.change(s.search()!, { target: { value: 'Creat' } });
    expect(s.list()).not.toBeNull();
    fireEvent.pointerDown(document.body, { pointerType: 'touch', isPrimary: true });
    expect(s.list()).toBeNull();
    fireEvent.focus(s.search()!);
    expect(s.list()).not.toBeNull();
  });

  it('a press inside the add box, on the search, leaves the list open', async () => {
    const s = await open();
    fireEvent.pointerDown(s.search()!, { pointerType: 'mouse', isPrimary: true });
    expect(s.list()).not.toBeNull();
  });

  it('Escape on the closed row does nothing; an added supplement clears the search for the next open', async () => {
    const s = await open();
    fireEvent.change(s.search()!, { target: { value: 'creatine' } });
    fireEvent.keyDown(s.search()!, { key: 'Enter' });
    expect(s.names()).toContain('Creatine');
    fireEvent.keyDown(s.row()!, { key: 'Escape' });
    expect(s.row()).not.toBeNull();
    expect(document.activeElement).toBe(s.row());
    fireEvent.click(s.row()!);
    expect(s.search()!.value).toBe('');
  });

  it('a touch that is a mouse press never adds from touchend', async () => {
    const s = await open();
    const creatine = s.option('Creatine')!;
    fireEvent.pointerDown(creatine, { pointerType: 'mouse', isPrimary: true });
    expect(fireEvent.touchEnd(creatine, { changedTouches: [{ clientX: 1, clientY: 1 }] })).toBe(true);
    expect(s.names()).not.toContain('Creatine');
  });
});
