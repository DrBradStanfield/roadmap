// @vitest-environment jsdom
/**
 * US-12 AC1a: the drop zone opens the file chooser from the keyboard. The real
 * file input is hidden, so before this the drop zone (a plain div) was the only
 * way to choose a file, and a keyboard user could not reach it. Synthetic: jsdom
 * opens no chooser, so the tests spy on the hidden input's click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { getDocumentArchiveMode } from '../lib/roadmap-data';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn(), labImportBatch: vi.fn(), pollBatchStatus: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ getDocumentArchiveMode: vi.fn(() => 'cloud'), bulkSaveMeasurements: vi.fn(), bulkSaveDocuments: vi.fn(), bulkSaveLabValues: vi.fn(), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

let inputClicks: ReturnType<typeof vi.fn<() => void>>;

function renderModal() {
  render(<UploadModal open onOpen={() => {}} onClose={() => {}} onComplete={() => {}} unitSystem="si" grading={{}} history={{ measurements: [], labValues: [], documents: [] }} />);
  const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
  inputClicks = vi.fn<() => void>();
  input.click = inputClicks;
  return screen.getByRole('button', { name: /Drop health records here, or click to browse/ });
}

beforeEach(() => { vi.mocked(getDocumentArchiveMode).mockReturnValue('cloud'); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('US-12 AC1a: choosing a file from the keyboard', () => {
  it('names the drop zone as a button in the tab order, keeping its drop zone class', () => {
    const zone = renderModal();
    expect(zone.tabIndex).toBe(0);
    expect(zone.className).toBe('upload-dropzone');
  });

  it('Enter on the drop zone opens the file chooser once', () => {
    const zone = renderModal();
    const notPrevented = fireEvent.keyDown(zone, { key: 'Enter' });
    expect(inputClicks).toHaveBeenCalledOnce();
    expect(notPrevented).toBe(false);
  });

  it('Space on the drop zone opens the file chooser once and does not scroll the page', () => {
    const zone = renderModal();
    const notPrevented = fireEvent.keyDown(zone, { key: ' ' });
    expect(inputClicks).toHaveBeenCalledOnce();
    expect(notPrevented).toBe(false);
  });

  it('other keys leave the chooser closed and the key to the page', () => {
    const zone = renderModal();
    for (const key of ['Tab', 'a', 'Escape', 'ArrowDown']) expect(fireEvent.keyDown(zone, { key })).toBe(true);
    expect(inputClicks).not.toHaveBeenCalled();
  });

  it('a click still opens the file chooser, as before', () => {
    const zone = renderModal();
    fireEvent.click(zone);
    expect(inputClicks).toHaveBeenCalledOnce();
  });

});
