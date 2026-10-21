// @vitest-environment jsdom
/**
 * US-13 AC6 — a document's date is its own, reviewed apart from the blood-test
 * column, and only a past calendar day the user saw is saved. Based on Austin
 * Bell's PR #152 (robertaustinbell). Synthetic documents only.
 */
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
  const pick = (value: string) => fireEvent.change(view.getByLabelText('Document date'), { target: { value } });
  const box = () => view.container.querySelector<HTMLInputElement>('.review-screening-update input')!;
  const promise = () => view.container.querySelector('.review-screening-update')?.textContent ?? '';
  const save = () => {
    fireEvent.click(view.getByRole('button', { name: /^Save / }));
    return onSave.mock.lastCall![0];
  };
  return { ...view, onSave, pick, box, promise, save };
}

describe('US-13 AC6: reviewed document dates', () => {
  it('saves the edited document date and names it in the screening promise', () => {
    const view = review('2024-06-10');
    view.pick('2024-07-12');
    expect(view.promise()).toContain('2024-07-12');
    expect(view.save().documents[0]).toMatchObject({ documentDate: '2024-07-12',
      screeningUpdate: { key: 'colorectal_last_date', date: '2024-07-12' } });
  });

  it('saves the extracted day untouched, even with no report date', () => {
    const view = review('2024-06-10');
    expect((view.getByLabelText('Document date') as HTMLInputElement).value).toBe('2024-06-10');
    expect(view.promise()).toContain('2024-06-10');
    expect(view.save().documents[0]).toMatchObject({ documentDate: '2024-06-10',
      screeningUpdate: { key: 'colorectal_last_date', date: '2024-06-10' } });
  });

  it.each([null, '2023-02-18'])('an unknown date saves null and never this month or the report date (report: %s)', reportDate => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    const view = review(null, reportDate);
    expect(view.getByText('Date unknown')).toBeTruthy();
    // The picker starts empty, so any day the user picks fires a change.
    expect((view.getByLabelText('Document date') as HTMLInputElement).value).toBe('');
    expect(view.box().disabled).toBe(true);
    expect(view.box().checked).toBe(false);
    expect(view.save().documents[0]).toMatchObject({ documentDate: null, screeningUpdate: undefined });
    view.pick('2024-08-09');
    expect(view.box().disabled).toBe(false);
    expect(view.promise()).toContain('2024-08-09');
    expect(view.save().documents[0]).toMatchObject({ documentDate: '2024-08-09',
      screeningUpdate: { key: 'colorectal_last_date', date: '2024-08-09' } });
    view.pick('');
    expect(view.box().disabled).toBe(true);
    expect(view.save().documents[0]).toMatchObject({ documentDate: null, screeningUpdate: undefined });
  });

  it('a month alone leaves the day blank; the screening keeps the month', () => {
    const view = review('2024-06');
    expect(view.container.querySelector('.review-file-date .bt-date-day')?.textContent).toContain('— Jun');
    expect((view.getByLabelText('Document date') as HTMLInputElement).value).toBe('');
    expect(view.promise()).toContain('to 2024-06');
    expect(view.save().documents[0]).toMatchObject({ documentDate: null,
      screeningUpdate: { key: 'colorectal_last_date', date: '2024-06' } });
    // The 1st can be picked: the picker was empty, so it fires.
    view.pick('2024-06-01');
    expect(view.save().documents[0]).toMatchObject({ documentDate: '2024-06-01',
      screeningUpdate: { key: 'colorectal_last_date', date: '2024-06-01' } });
  });

  it('keeps document and blood-test dates independent through edits to both', () => {
    const view = review('2024-06-10', '2023-02-18', true);
    expect((view.getByLabelText('Choose column date') as HTMLInputElement).value).toBe('2023-02-18');
    view.pick('2024-07-12');
    expect(view.save().values[0].recordedAt).toBe('2023-02-18T00:00:00.000Z');
    fireEvent.change(view.getByLabelText('Choose column date'), { target: { value: '2023-03-19' } });
    const saved = view.save();
    expect(saved.values[0].recordedAt).toBe('2023-03-19T00:00:00.000Z');
    expect(saved.documents[0]).toMatchObject({ documentDate: '2024-07-12',
      screeningUpdate: { key: 'colorectal_last_date', date: '2024-07-12' } });
  });

  it('keeps an explicit screening opt-out through edits, clearing and reselection', () => {
    const view = review('2024-06-10');
    fireEvent.click(view.box());
    for (const date of ['2024-07-12', '', '2024-08-09']) {
      view.pick(date);
      expect(view.box().checked).toBe(false);
      expect(view.save().documents[0].screeningUpdate).toBeUndefined();
    }
  });

  it.each(['2024-13-45', '15/06/2024', 'junk', '2024-02-30', '2024-13', '2027-01-05', '2027-01'])(
    'a document date that is not a past calendar day or month (%s) is unknown', raw => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
      const view = review(raw);
      expect(view.getByText('Date unknown')).toBeTruthy();
      expect(view.box().disabled).toBe(true);
      expect(view.save().documents[0]).toMatchObject({ documentDate: null, screeningUpdate: undefined });
    });

  it('a future pick is refused and not written', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    const view = review('2024-06-10');
    view.pick('2027-01-05');
    expect(view.save().documents[0]).toMatchObject({ documentDate: '2024-06-10' });
  });

  it('a timestamp is read as its calendar day, as the connector reads it', () => {
    const view = review('2024-06-10T09:30:00Z');
    expect(view.save().documents[0]).toMatchObject({ documentDate: '2024-06-10' });
  });

  // US-14 AC4: a re-upload replaces a failed row of its own kind, so the card
  // starts from that row: the user sees the earlier edits, and can change them.
  it('starts from the failed row the upload will replace, and saves what the card shows', () => {
    const letter: FileResult = { fileName: 'synthetic-letter.pdf', reportDate: null, values: [], additionalValues: [],
      file: new Blob(['synthetic']), contentHash: 'sha256-synthetic',
      document: { classification: 'clinic_letter', title: 'Extracted title', documentDate: '2024-06-01', contentMarkdown: 'Synthetic', metadata: {} } };
    const row = (over: object) => ({ id: 'r1', documentType: 'clinic_letter', title: 'Earlier title', documentDate: '2024-05-20', contentMd: 'Synthetic',
      metadata: {}, sourceFileName: 'synthetic-letter.pdf', contentHash: 'sha256-synthetic', fileRef: null, createdAt: '2024-06-02T00:00:00Z', ...over });
    const onSave = vi.fn();
    const view = render(<ReviewTable results={[letter]} history={{ measurements: [], labValues: [], documents: [row({})] }}
      unitSystem="si" grading={{}} onSave={onSave} onCancel={() => {}} isSaving={false} error={null} />);
    expect(view.getByDisplayValue('Earlier title')).toBeTruthy();
    expect((view.getByLabelText('Document date') as HTMLInputElement).value).toBe('2024-05-20');
    fireEvent.click(view.getByRole('button', { name: /^Save / }));
    expect(onSave.mock.lastCall![0].reviewed[0].document).toMatchObject({ title: 'Earlier title', documentDate: '2024-05-20' });
    cleanup();
    // An archived row, or a lab-archive row, is not one it replaces: the extraction stands.
    for (const other of [row({ fileRef: 'Letters/a.pdf' }), row({ documentType: 'pathology_report', title: 'Blood test results', contentMd: '' })]) {
      const again = render(<ReviewTable results={[letter]} history={{ measurements: [], labValues: [], documents: [other] }}
        unitSystem="si" grading={{}} onSave={() => {}} onCancel={() => {}} isSaving={false} error={null} />);
      expect(again.getByDisplayValue('Extracted title')).toBeTruthy();
      cleanup();
    }
  });

  it('starts from the newest such row, and a held row with no date stays unknown', () => {
    const letter: FileResult = { fileName: 'synthetic-letter.pdf', reportDate: null, values: [], additionalValues: [],
      file: new Blob(['synthetic']), contentHash: 'sha256-synthetic',
      document: { classification: 'clinic_letter', title: 'Extracted title', documentDate: '2024-06-01', contentMarkdown: 'Synthetic', metadata: {} } };
    const row = (id: string, title: string, createdAt: string, documentDate: string | null) => ({ id, documentType: 'clinic_letter', title, documentDate,
      contentMd: 'Synthetic', metadata: {}, sourceFileName: 'synthetic-letter.pdf', contentHash: 'sha256-synthetic', fileRef: null, createdAt });
    const onSave = vi.fn();
    const view = render(<ReviewTable results={[letter]} grading={{}} unitSystem="si" onSave={onSave} onCancel={() => {}} isSaving={false} error={null}
      history={{ measurements: [], labValues: [], documents: [row('old', 'Older title', '2024-06-02T00:00:00Z', '2024-05-01'), row('new', 'Newer title', '2024-07-02T00:00:00Z', null)] }} />);
    expect(view.getByDisplayValue('Newer title')).toBeTruthy();
    expect(view.getByText('Date unknown')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: /^Save / }));
    expect(onSave.mock.lastCall![0].reviewed[0].document).toMatchObject({ title: 'Newer title', documentDate: null });
  });

  it('a clear makes a month-only date unknown too: no month comes back, no screening write', () => {
    const view = review('2024-06');
    view.pick('2024-06-12');
    view.pick('');
    expect(view.getByText('Date unknown')).toBeTruthy();
    expect(view.box().disabled).toBe(true);
    expect(view.promise()).not.toContain('2024-06');
    expect(view.save().documents[0]).toMatchObject({ documentDate: null, screeningUpdate: undefined });
  });

  it('hands back every result as reviewed: title, document date and report column day', () => {
    const view = review('2024-06', '2023-02-18', true);
    fireEvent.change(view.getByDisplayValue('Synthetic colonoscopy'), { target: { value: 'Reviewed title' } });
    view.pick('2024-06-12');
    fireEvent.change(view.getByLabelText('Choose column date'), { target: { value: '2023-03-19' } });
    expect(view.save().reviewed[0]).toMatchObject({ reportDate: '2023-03-19',
      document: { title: 'Reviewed title', documentDate: '2024-06-12' } });
  });
});
