// @vitest-environment jsdom
/**
 * US-12 AC4a: the upload window is a dialog. It is named by its title, it
 * takes the focus when it opens, and hiding it gives the focus back to what
 * opened it. Before this it was a plain box at the end of the page: the focus
 * stayed on the button behind the backdrop, and Settings' Escape check
 * (`[aria-modal="true"]`) could not see it. Synthetic: no file is read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { SettingsSheet } from './SettingsSheet';
import { getDocumentArchiveMode } from '../lib/roadmap-data';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn(), labImportBatch: vi.fn(), pollBatchStatus: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ getDocumentArchiveMode: vi.fn(() => 'cloud'), bulkSaveMeasurements: vi.fn(), bulkSaveDocuments: vi.fn(), bulkSaveLabValues: vi.fn(), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const history = { measurements: [], labValues: [], documents: [] };

/** The page: an opener button and the modal, shown and hidden as HealthTool does. */
function Page({ startOpen = false, mounted = true }: { startOpen?: boolean; mounted?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return <>
    <button type="button" onClick={() => setOpen(true)}>Upload lab results</button>
    <button type="button">Somewhere else</button>
    {mounted && <UploadModal open={open} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} onComplete={() => {}} unitSystem="si" grading={{}} history={history} />}
  </>;
}

function openFromButton() {
  const opener = screen.getByRole('button', { name: 'Upload lab results' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

const title = () => screen.getByRole('heading', { name: 'Upload Health Records' });

beforeEach(() => { vi.mocked(getDocumentArchiveMode).mockReturnValue('cloud'); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('US-12 AC4a: the upload window is a dialog', () => {
  it('is a modal dialog named by its title', () => {
    render(<Page />);
    openFromButton();
    const dialog = screen.getByRole('dialog', { name: 'Upload Health Records' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.className).toBe('upload-modal');
    expect(dialog.contains(title())).toBe(true);
  });

  it('opening it moves the focus to its title, inside the dialog', () => {
    render(<Page />);
    openFromButton();
    expect(document.activeElement).toBe(title());
    expect(title().tabIndex).toBe(-1);
  });

  it('a window shown on its first render takes the focus too', () => {
    render(<Page startOpen />);
    expect(document.activeElement).toBe(title());
  });

  it('Close gives the focus back to the button that opened it', () => {
    render(<Page />);
    const opener = openFromButton();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Escape hides it, as before, and gives the focus back', () => {
    render(<Page />);
    const opener = openFromButton();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('a click on the backdrop hides it and gives the focus back', () => {
    render(<Page />);
    const opener = openFromButton();
    fireEvent.click(document.querySelector('.upload-modal-backdrop')!);
    expect(document.activeElement).toBe(opener);
  });

  it('opening it a second time takes the focus again and gives it back again', () => {
    render(<Page />);
    const opener = openFromButton();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    openFromButton();
    expect(document.activeElement).toBe(title());
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(opener);
  });

  it('a hidden window claims no aria-modal, so Settings keeps its Escape', () => {
    render(<Page />);
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    openFromButton();
    expect(document.querySelector('[aria-modal="true"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  it('with a session hidden, Escape in Settings still closes Settings; with the window open, it does not', () => {
    const onSettingsClose = vi.fn();
    render(<><Page /><SettingsSheet onClose={onSettingsClose}><p>Units</p></SettingsSheet></>);
    const opener = openFromButton();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(opener);
    fireEvent.keyDown(screen.getByRole('heading', { name: 'Settings' }), { key: 'Escape' });
    expect(onSettingsClose).toHaveBeenCalledOnce();
    openFromButton();
    fireEvent.keyDown(screen.getByRole('heading', { name: 'Settings' }), { key: 'Escape' });
    expect(onSettingsClose).toHaveBeenCalledOnce();
  });

  it('hiding it leaves the focus where something else has since put it outside the window', () => {
    render(<Page />);
    openFromButton();
    const elsewhere = screen.getByRole('button', { name: 'Somewhere else' });
    elsewhere.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(elsewhere);
  });

  it('a window removed while open (an erase mounts a new one) gives the focus back', () => {
    const { rerender } = render(<Page />);
    const opener = openFromButton();
    act(() => { rerender(<Page mounted={false} />); });
    expect(document.activeElement).toBe(opener);
  });

  it('a window removed while the focus is outside it leaves the focus there', () => {
    const { rerender } = render(<Page />);
    openFromButton();
    const elsewhere = screen.getByRole('button', { name: 'Somewhere else' });
    elsewhere.focus();
    act(() => { rerender(<Page mounted={false} />); });
    expect(document.activeElement).toBe(elsewhere);
  });
});
