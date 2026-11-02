// @vitest-environment jsdom
/**
 * The upload code is its own bundle (upload-entry.ts). UploadModal adds its
 * script on first use and reads the code from window.HealthUpload once the
 * script has run. The other UploadModal tests set window.HealthUpload first, so
 * they never take this path. Synthetic: jsdom loads no script, so the test runs
 * its onload itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { UploadModal } from './UploadModal';
import { checkLabImportQuota, labImport } from '../lib/upload-api';
import type { HealthUploadAPI } from '../upload-entry';

vi.mock('../lib/upload-api', () => ({ checkLabImportQuota: vi.fn(), labImport: vi.fn(), labImportBatch: vi.fn(), pollBatchStatus: vi.fn() }));
vi.mock('../lib/roadmap-data', () => ({ getDocumentArchiveMode: vi.fn(() => 'cloud'), bulkSaveMeasurements: vi.fn(), bulkSaveDocuments: vi.fn(), bulkSaveLabValues: vi.fn(), getLpaUnit: vi.fn(), setLpaUnit: vi.fn(), getEraseIdentity: vi.fn(() => ''), getShownErase: vi.fn(() => '') }));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const BUNDLE = 'https://cdn.example/health-upload.js';
const extractFromPdf = vi.fn();
let scripts: HTMLScriptElement[];

beforeEach(() => {
  vi.mocked(checkLabImportQuota).mockResolvedValue({ allowed: true, remaining: 60 });
  vi.mocked(labImport).mockReturnValue(new Promise(() => {}));
  extractFromPdf.mockResolvedValue({ pages: [{ type: 'text', content: 'synthetic' }], truncated: false });
  delete window.HealthUpload;
  const root = document.createElement('div');
  root.id = 'health-tool-root';
  root.dataset.uploadUrl = BUNDLE;
  document.body.appendChild(root);
  scripts = [];
  const append = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
    if (node instanceof HTMLScriptElement) { scripts.push(node); return node; }
    return append(node);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  document.getElementById('health-tool-root')?.remove();
  delete window.HealthUpload;
});

describe('UploadModal loads the upload bundle', () => {
  it('adds the bundle script once, then reads the code the bundle put on window.HealthUpload', async () => {
    render(<UploadModal open onOpen={() => {}} onClose={() => {}} onComplete={() => {}} unitSystem="si" grading={{}} history={{ measurements: [], labValues: [], documents: [] }} />);
    fireEvent.change(document.querySelector('input[type=file]')!, { target: { files: [new File(['synthetic'], 'test.pdf', { type: 'application/pdf' })] } });
    await waitFor(() => expect(scripts).toHaveLength(1));
    expect(scripts[0].src).toBe(BUNDLE);
    expect(extractFromPdf).not.toHaveBeenCalled();
    window.HealthUpload = { extractFromPdf, isPdf: () => true, isZip: () => false, isImage: () => false } as unknown as HealthUploadAPI;
    scripts[0].onload!(new Event('load'));
    await waitFor(() => expect(extractFromPdf).toHaveBeenCalledOnce());
  });
});
