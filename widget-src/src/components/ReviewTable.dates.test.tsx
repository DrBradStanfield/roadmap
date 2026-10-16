// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { ReviewTable, type FileResult } from './ReviewTable';

afterEach(() => { cleanup(); vi.useRealTimers(); });

function review(documentDate: string | null, reportDate: string | null = null, withLabs = false) {
  const result: FileResult = {
    fileName: 'synthetic-colonoscopy.pdf', reportDate,
    values: withLabs ? [{ metric: 'ldl', valueSI: 3, displayValue: 3, displayUnit: 'mmol/L', confidence: 'high' }] : [],
    additionalValues: [],
    document: { classification: 'scan_result', title: 'Synthetic colonoscopy', documentDate,
      contentMarkdown: 'Synthetic report', metadata: { screeningType: 'colorectal' } },
  };
  const onSave = vi.fn();
  const view = render(<ReviewTable results={[result]} history={{ measurements: [], labValues: [], documents: [] }}
    unitSystem="si" age={60} sex="male" grading={{}} onSave={onSave} onCancel={() => {}}
    isSaving={false} error={null} />);
  return { ...view, onSave, save: () => fireEvent.click(view.getByRole('button', { name: /^Save / })) };
}

describe('reviewed document dates (US-13 review-before-save; US-06 screening dates)', () => {
  it('keeps the edited document date in the screening promise and save payload', () => {
    const view = review('2024-06-10');
    fireEvent.change(view.getByLabelText('Document date'), { target: { value: '2024-07-12' } });
    expect(view.container.querySelector('.review-screening-update')?.textContent).toContain('2024-07-12');
    view.save();
    expect(view.onSave.mock.calls[0][0].documents[0]).toMatchObject({ documentDate: '2024-07-12',
      screeningUpdate: { key: 'colorectal_last_date', date: '2024-07-12' } });
  });
  it.each([null, '2023-02-18'])('does not confirm an unknown document date (blood report: %s)', reportDate => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    const view = review(null, reportDate);
    const box = view.container.querySelector<HTMLInputElement>('.review-screening-update input')!;
    expect(box.disabled).toBe(true);
    expect(box.checked).toBe(false);
    expect(view.getByText('Date unknown')).toBeTruthy();
    view.save();
    expect(view.onSave.mock.calls[0][0].documents[0]).toMatchObject({ documentDate: null, screeningUpdate: undefined });
    fireEvent.change(view.getByLabelText('Document date'), { target: { value: '2024-08-09' } });
    expect(box.disabled).toBe(false);
    expect(view.container.querySelector('.review-screening-update')?.textContent).toContain('2024-08-09');
    view.save();
    expect(view.onSave.mock.calls[1][0].documents[0]).toMatchObject({ documentDate: '2024-08-09',
      screeningUpdate: { key: 'colorectal_last_date', date: '2024-08-09' } });
    fireEvent.change(view.getByLabelText('Document date'), { target: { value: '' } });
    expect(box.disabled).toBe(true);
    view.save();
    expect(view.onSave.mock.calls[2][0].documents[0]).toMatchObject({ documentDate: null, screeningUpdate: undefined });
  });

  it('preserves a document month without claiming its first day was confirmed', () => {
    const view = review('2024-06');
    expect(view.container.querySelector('.review-file-date .bt-date-day')?.textContent).toContain('— Jun');
    expect(view.container.querySelector('.review-screening-update')?.textContent).toContain('to 2024-06');
    view.save();
    expect(view.onSave.mock.calls[0][0].documents[0]).toMatchObject({ documentDate: '2024-06',
      screeningUpdate: { key: 'colorectal_last_date', date: '2024-06' } });
  });

  it('keeps document and blood-test dates independent through edits to both', () => {
    const view = review('2024-06-10', '2023-02-18', true);
    expect((view.getByLabelText('Choose column date') as HTMLInputElement).value).toBe('2023-02-18');
    fireEvent.change(view.getByLabelText('Document date'), { target: { value: '2024-07-12' } });
    view.save();
    expect(view.onSave.mock.calls[0][0].values[0].recordedAt).toBe('2023-02-18T00:00:00.000Z');
    fireEvent.change(view.getByLabelText('Choose column date'), { target: { value: '2023-03-19' } });
    view.save();
    expect(view.onSave.mock.calls[1][0].values[0].recordedAt).toBe('2023-03-19T00:00:00.000Z');
    expect(view.onSave.mock.calls[1][0].documents[0]).toMatchObject({ documentDate: '2024-07-12',
      screeningUpdate: { key: 'colorectal_last_date', date: '2024-07-12' } });
    expect(view.container.querySelector('.review-screening-update')?.textContent).toContain('2024-07-12');
  });

  it('keeps an explicit screening opt-out through edits, clearing and reselection', () => {
    const view = review('2024-06-10');
    const box = view.container.querySelector<HTMLInputElement>('.review-screening-update input')!;
    fireEvent.click(box);
    for (const date of ['2024-07-12', '', '2024-08-09']) {
      fireEvent.change(view.getByLabelText('Document date'), { target: { value: date } });
      expect(box.checked).toBe(false);
      view.save();
      expect(view.onSave.mock.lastCall![0].documents[0].screeningUpdate).toBeUndefined();
    }
  });

  it('uses the extracted document date when the blood report date is absent', () => {
    const view = review('2024-06-10');
    expect((view.getByLabelText('Document date') as HTMLInputElement).value).toBe('2024-06-10');
    expect(view.container.querySelector('.review-screening-update')?.textContent).toContain('2024-06-10');
    view.save();
    expect(view.onSave.mock.calls[0][0].documents[0]).toMatchObject({ documentDate: '2024-06-10',
      screeningUpdate: { key: 'colorectal_last_date', date: '2024-06-10' } });
  });
});
