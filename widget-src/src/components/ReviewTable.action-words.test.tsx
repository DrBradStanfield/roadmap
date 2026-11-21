// @vitest-environment jsdom
/**
 * The review's Save and close words now come from health-core (`UPLOAD_TEXT`, web list PR 1e, US-13 AC26), moved from
 * this file byte for byte: what the grid draws is unchanged. "Close" with nothing to save is pinned in
 * ReviewTable.import-review.test.tsx. Synthetic values.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ReviewTable } from './ReviewTable';
import type { FileResult } from '../lib/upload-pipeline';

vi.mock('../lib/server-api', async (actual) => ({ ...(await actual<typeof import('../lib/server-api')>()), trackProductEvent: vi.fn() }));
afterEach(cleanup);

const labs: FileResult = { fileName: 'labs.pdf', reportDate: '2026-03-10', values: [{ metric: 'ldl', valueSI: 3.9, displayValue: 3.9, displayUnit: 'mmol/L', confidence: 'high' }], additionalValues: [] };
const draw = (isSaving: boolean) => render(<ReviewTable grading={{}} results={[labs]} history={{ measurements: [], labValues: [], documents: [] }}
  unitSystem="si" onSave={vi.fn()} onCancel={vi.fn()} isSaving={isSaving} error={null} />);

describe('the review\'s Save and close words (moved to health-core UPLOAD_TEXT)', () => {
  it('"Save 1 value" and "Cancel" while open', () => {
    draw(false);
    expect(screen.getByRole('button', { name: 'Save 1 value' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('"Saving..." while it saves, and "Cancel" disabled', () => {
    draw(true);
    expect(screen.getByRole('button', { name: 'Saving...' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
