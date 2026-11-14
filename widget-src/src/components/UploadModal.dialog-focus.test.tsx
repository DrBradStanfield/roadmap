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
import { checkLabImportQuota } from '../lib/upload-api';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn(), labImportBatch: vi.fn(), pollBatchStatus: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ getDocumentArchiveMode: vi.fn(() => 'cloud'), bulkSaveMeasurements: vi.fn(), bulkSaveDocuments: vi.fn(), bulkSaveLabValues: vi.fn(), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const history = { measurements: [], labValues: [], documents: [] };

/** The page: an opener button and the modal, shown and hidden as HealthTool does. */
function Page({ startOpen = false, mounted = true, withOpener = true }: { startOpen?: boolean; mounted?: boolean; withOpener?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return <>
    {withOpener && <button type="button" onClick={() => setOpen(true)}>Upload lab results</button>}
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
afterEach(() => { cleanup(); vi.clearAllMocks(); delete (window as { HealthUpload?: unknown }).HealthUpload; });

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

  it('a window reopened from the floating indicator gives the focus back to the indicator shown on hiding it', async () => {
    vi.mocked(checkLabImportQuota).mockReturnValue(new Promise(() => {}) as never); // the file is still being read
    render(<Page />);
    const opener = openFromButton();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['synthetic'], 'synthetic.pdf', { type: 'application/pdf' })] } }); });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
    const indicator = document.querySelector<HTMLElement>('.floating-upload-indicator')!;
    indicator.focus();
    fireEvent.keyDown(indicator, { key: 'Enter' }); // the indicator leaves the page as the window shows
    expect(document.activeElement).toBe(title());
    fireEvent.keyDown(document, { key: 'Escape' });
    const shown = document.querySelector('.floating-upload-indicator');
    expect(shown).not.toBeNull();
    expect(document.activeElement).toBe(shown);
  });

  it('an opener that left the page while the window was open: hiding gives the focus to the floating indicator', async () => {
    vi.mocked(checkLabImportQuota).mockReturnValue(new Promise(() => {}) as never);
    const { rerender } = render(<Page />);
    openFromButton();
    act(() => { rerender(<Page withOpener={false} />); });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['synthetic'], 'synthetic.pdf', { type: 'application/pdf' })] } }); });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    const shown = document.querySelector('.floating-upload-indicator');
    expect(shown).not.toBeNull();
    expect(document.activeElement).toBe(shown);
  });

  it('a failed read reopened from the floating indicator, then Close: the session ends, no indicator shows, the focus is not moved', async () => {
    let fail!: (error: Error) => void;
    vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 } as never);
    Object.assign(window, { HealthUpload: { extractFromPdf: () => new Promise((_, no) => { fail = no; }), isPdf: () => true, isZip: () => false, isImage: () => false } });
    render(<Page />);
    openFromButton();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['synthetic'], 'synthetic.pdf', { type: 'application/pdf' })] } }); });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await act(async () => { fail(new Error('synthetic unreadable file')); });
    const indicator = await screen.findByRole('button', { name: /Upload needs attention/ });
    indicator.focus();
    fireEvent.keyDown(indicator, { key: 'Enter' });
    const shownTitle = title();
    expect(document.activeElement).toBe(shownTitle);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.querySelector('.floating-upload-indicator')).toBeNull();
    expect(document.activeElement).toBe(shownTitle); // not moved: jsdom keeps it on the hidden title, a browser drops it to the body
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
