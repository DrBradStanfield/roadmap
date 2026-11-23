// @vitest-environment jsdom
// US-12 AC32 (the web side of US-52 AC13b): what the upload does, drawn as the iPhone draws it,
// with real text below that says who reads the files.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { UPLOAD_EXPLAINER_TEXT } from '@roadmap/health-core/upload-text';
import { UploadExplainer } from './UploadExplainer';

afterEach(cleanup);

const drawing = (container: HTMLElement) => container.querySelector<HTMLElement>('.upload-explainer-drawing')!;

describe('US-12 AC32: the upload explainer', () => {
  it('draws the letter, the lab report, the three results and the record, hidden from screen readers', () => {
    const { container } = render(<UploadExplainer reader="server" />);
    const art = drawing(container);
    expect(art.getAttribute('aria-hidden')).toBe('true');
    for (const word of [UPLOAD_EXPLAINER_TEXT.letter, UPLOAD_EXPLAINER_TEXT.labReport, UPLOAD_EXPLAINER_TEXT.record, ...UPLOAD_EXPLAINER_TEXT.results]) {
      expect(art.textContent).toContain(word);
    }
    // Three chips fly and three ticks wait in the record, one per result.
    expect(art.querySelectorAll('.upload-explainer-chip')).toHaveLength(3);
    expect(art.querySelectorAll('.upload-explainer-tick')).toHaveLength(3);
  });

  it('shows result names, never a value', () => {
    const { container } = render(<UploadExplainer reader="server" />);
    let text = drawing(container).textContent ?? '';
    for (const name of UPLOAD_EXPLAINER_TEXT.results) text = text.split(name).join('');
    expect(text).not.toMatch(/\d/);
  });

  it('says what the upload does, as real text outside the drawing', () => {
    const { container } = render(<UploadExplainer reader="server" />);
    const what = screen.getByText(UPLOAD_EXPLAINER_TEXT.what);
    expect(drawing(container).contains(what)).toBe(false);
    expect(what.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('names our server when the server reads the files (the US-09 AC5 "our server" rule)', () => {
    render(<UploadExplainer reader="server" />);
    expect(screen.getByText('Claude reads them through our server, which keeps no copy.')).toBeTruthy();
    expect(screen.queryByText(UPLOAD_EXPLAINER_TEXT.reader.ownKey)).toBeNull();
  });

  it("names the person's own key when it reads the files, and no server of ours", () => {
    render(<UploadExplainer reader="ownKey" />);
    expect(screen.getByText('Claude reads them with your own Anthropic key. No server of ours sees them.')).toBeTruthy();
    expect(screen.queryByText(UPLOAD_EXPLAINER_TEXT.reader.server)).toBeNull();
  });

  it('pins the approved words, with no em dash', () => {
    // "You review them": sure values sit behind Show all (US-13 AC13), so not each one is checked.
    expect(UPLOAD_EXPLAINER_TEXT.what).toBe(
      'Add your medical records: a ZIP, PDFs or photos. We read the test results in your lab reports and clinic letters. You review them before anything is saved.',
    );
    expect(UPLOAD_EXPLAINER_TEXT.connectTitle).toBe('Keep the original files too?');
    // With no cloud a letter's read text is still saved, as a text-only row (US-52 AC13d).
    expect(UPLOAD_EXPLAINER_TEXT.connectText).toBe(
      'Connect your own Dropbox or Google Drive and your original files are kept there, in folders such as Lab results, Clinic letters and Scans. Without it, what we read from each file is saved, but the file itself is not kept.',
    );
    expect(UPLOAD_EXPLAINER_TEXT.connectSkip).toBe('Continue without keeping the files ›');
    for (const words of Object.values(UPLOAD_EXPLAINER_TEXT).flat()) {
      for (const line of typeof words === 'string' ? [words] : Object.values(words)) expect(line).not.toMatch(/—/);
    }
  });
});
