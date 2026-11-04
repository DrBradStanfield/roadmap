// @vitest-environment jsdom
/**
 * US-14 AC7: a saved document opens on screen. The widget's `.health-tool`
 * box is transformed (`translateX(-50%)`, styles.css) and clipped, and a
 * transformed box is the containing block of every `position: fixed`
 * descendant. The viewer's fixed backdrop rendered inside it covers the whole
 * widget, not the screen, so a document opened from the list at the foot of
 * My data centres in the widget, far above the part on screen. The viewer
 * portals to <body>, like the upload review and the alcohol dialog, and so
 * carries the Clarity mask itself (US-09 AC8).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DocumentLightbox } from './DocumentLightbox';
import type { ApiDocument } from '../lib/api-types';

vi.mock('../lib/roadmap-data', () => ({ readDocumentFile: vi.fn(), deleteDocument: vi.fn() }));
vi.mock('../lib/useIsMobile', () => ({ useIsMobile: () => false }));

const doc: ApiDocument = {
  id: 'd1', documentType: 'scan_result', title: 'Synthetic chest X-ray', documentDate: '2024-06-01',
  contentMd: 'No acute findings.', metadata: {}, sourceFileName: 'scan', createdAt: '2024-06-01T00:00:00Z',
  fileRef: '', contentHash: 'sha256-x',
};

/** The viewer as HealthRecordsSection renders it: inside the widget root and its transformed box. */
function openInWidget(onClose = vi.fn()) {
  render(
    <div id="health-tool-root" data-clarity-mask="true">
      <div className="health-tool"><DocumentLightbox doc={doc} onClose={onClose} /></div>
    </div>,
  );
  const backdrop = screen.getByRole('heading', { name: 'Synthetic chest X-ray' }).closest('.upload-modal-backdrop') as HTMLElement;
  expect(backdrop).not.toBeNull();
  return backdrop;
}

afterEach(() => { cleanup(); });

describe('US-14 AC7: a saved document opens on screen', () => {
  it('the viewer is laid out against the screen, not inside the transformed widget box', () => {
    const backdrop = openInWidget();
    expect(backdrop.closest('.health-tool')).toBeNull();
    expect(backdrop.parentElement).toBe(document.body);
  });

  it('the viewer is still masked from session recordings (US-09 AC8)', () => {
    openInWidget();
    expect(screen.getByText('No acute findings.').closest('[data-clarity-mask="true"]')).not.toBeNull();
  });

  it('a click on the backdrop still closes it, and a click inside does not', () => {
    const onClose = vi.fn();
    const backdrop = openInWidget(onClose);
    fireEvent.click(screen.getByText('No acute findings.'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
