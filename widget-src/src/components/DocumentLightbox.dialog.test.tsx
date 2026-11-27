// @vitest-environment jsdom
/**
 * US-14 AC7a: the document viewer is a modal dialog, opened with showModal()
 * through the standalone's own hook (US-09 AC34). It is named by the
 * document's title, takes the focus to that title, and gives the focus back to
 * the row that opened it when it closes. Before this it was a plain box: the
 * focus stayed on the row behind the backdrop and Tab walked the page behind.
 * jsdom has no showModal, so the stub does what the tests need: it opens the
 * dialog and moves the focus to its first button, as Firefox does (Chromium
 * and WebKit focus the title itself). jsdom does not move the focus on Tab, so
 * Tab order is not tested here. Synthetic document only.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { StrictMode, useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocumentLightbox } from './DocumentLightbox';
import { deleteDocument } from '../lib/roadmap-data';
import type { ApiDocument } from '../lib/api-types';

vi.mock('../lib/roadmap-data', () => ({ readDocumentFile: vi.fn(), deleteDocument: vi.fn(), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));

const doc: ApiDocument = {
  id: 'd1', documentType: 'scan_result', title: 'Synthetic chest X-ray', documentDate: '2024-06-01',
  contentMd: 'No acute findings. See [the synthetic guide](https://example.org/guide).', metadata: {},
  sourceFileName: 'scan', createdAt: '2024-06-01T00:00:00Z', fileRef: 'Documents/scan.pdf', contentHash: 'sha256-x',
};

const shown: HTMLDialogElement[] = [];
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    shown.push(this);
    this.setAttribute('open', '');
    this.querySelector('button')?.focus();
  };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); shown.length = 0; });

/** A documents list as MyHealth draws it: a row button opens the viewer, a delete takes the row away. */
function Page() {
  const [open, setOpen] = useState(false);
  const [listed, setListed] = useState(true);
  return <>
    {listed && <button type="button" onClick={() => setOpen(true)}>Synthetic chest X-ray row</button>}
    {open && <DocumentLightbox doc={doc} onClose={() => setOpen(false)} onDeleted={() => setListed(false)} />}
  </>;
}

function openFromRow(strict = false) {
  render(strict ? <StrictMode><Page /></StrictMode> : <Page />);
  const row = screen.getByRole('button', { name: 'Synthetic chest X-ray row' });
  row.focus();
  fireEvent.click(row);
  return row;
}

const dialog = () => screen.getByRole('dialog', { name: 'Synthetic chest X-ray' }) as HTMLDialogElement;
const title = () => screen.getByRole('heading', { name: 'Synthetic chest X-ray' });
const button = (name: string) => screen.getByRole('button', { name });

describe('US-14 AC7a: the document viewer is a modal dialog', () => {
  it.each([false, true])('opens with showModal, named by its title, and moves the focus to that title (StrictMode %s)', (strict) => {
    openFromRow(strict);
    expect(dialog().tagName).toBe('DIALOG');
    expect(shown.at(-1)).toBe(dialog());
    expect(dialog().contains(button('Close'))).toBe(true);
    expect(document.activeElement).toBe(title());
    expect(document.documentElement.style.overflow).toBe('hidden');
  });

  it.each([
    ['Close', () => fireEvent.click(button('Close'))],
    ['Escape (the dialog\'s cancel)', () => fireEvent(dialog(), new Event('cancel', { cancelable: true }))],
    ['a click on the backdrop', () => fireEvent.click(dialog())],
  ])('%s closes it and gives the focus back to the row that opened it', (_, close) => {
    const row = openFromRow();
    expect(document.activeElement).toBe(title());
    close();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(row);
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('a click inside the box does not close it', () => {
    openFromRow();
    fireEvent.click(screen.getByText(/No acute findings/));
    expect(dialog()).toBeTruthy();
  });

  it('a delete that takes the row away closes it and leaves the focus on the page body', async () => {
    vi.mocked(deleteDocument).mockResolvedValue(true);
    openFromRow();
    fireEvent.click(button('Delete Document'));
    fireEvent.click(button('Confirm Delete'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: 'Synthetic chest X-ray row' })).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  it('no key is held back from the browser: Tab, Enter, Space, the arrows, Page Up and Down, Home and End', () => {
    openFromRow();
    const text = document.querySelector<HTMLElement>('.doc-lightbox-content')!;
    const keys = ['Tab', 'Enter', ' ', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End'];
    for (const target of [title(), button('Close'), text, button('Delete Document')]) {
      for (const key of keys) expect(fireEvent.keyDown(target, { key }), `${key} on ${target.tagName}`).toBe(true);
      expect(fireEvent.keyDown(target, { key: 'Tab', shiftKey: true })).toBe(true);
    }
    expect(dialog()).toBeTruthy();
  });
});
