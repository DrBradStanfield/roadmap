// @vitest-environment jsdom
/**
 * US-06 AC5 — with no plan there is no age, and isScreeningEligible(st,
 * undefined, sex) answers true. The upload review must not then pre-tick a
 * screening-date update the plan never asked for. The user can still tick it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ReviewTable, type FileResult } from './ReviewTable';

afterEach(cleanup);

const colonoscopy: FileResult[] = [{
  fileName: 'colonoscopy.pdf',
  reportDate: null,
  values: [],
  additionalValues: [],
  document: {
    classification: 'scan_result', title: 'Colonoscopy report', documentDate: '2025-03-10',
    contentMarkdown: '# Colonoscopy', metadata: { screeningType: 'colorectal' },
  },
  file: new Blob(['bytes'], { type: 'application/pdf' }),
  contentHash: 'sha256-colo',
}];

function screeningBox(age: number | undefined) {
  const { container } = render(
    <ReviewTable
      grading={{}}
      results={colonoscopy}
      history={{ bloodTests: [], labValues: [], documents: [] }}
      unitSystem="si"
      age={age}
      sex="male"
      onSave={() => {}}
      onCancel={() => {}}
      isSaving={false}
      error={null}
    />,
  );
  return container.querySelector<HTMLInputElement>('.review-screening-update input')!;
}

describe('ReviewTable — screening-date checkbox (US-06 AC5)', () => {
  it('US-06 AC5: with no age it starts unticked, and the user can still tick it', () => {
    const box = screeningBox(undefined);
    expect(box).not.toBeNull();
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect(box.checked).toBe(true);
  });

  it('US-06 AC5: with an eligible age it still starts ticked', () => {
    expect(screeningBox(60).checked).toBe(true);
  });
});

// US-07 AC6 (amended 2026-10-14): a known minor's upload review withholds the
// adult reference hints and status colours, as the blood-test matrix does.
// The extracted values stay, editable.
describe('ReviewTable — a known minor sees values with no adult hint or colour (US-07 AC6)', () => {
  const ldlFile: FileResult[] = [{
    fileName: 'labs.pdf', reportDate: '2026-09-01', additionalValues: [],
    values: [{ metric: 'ldl', valueSI: 4, displayValue: 4, displayUnit: 'mmol/L', confidence: 'high' }],
  } as unknown as FileResult];
  function ldlRow(knownMinor: boolean) {
    const { container } = render(
      <ReviewTable results={ldlFile} history={{ bloodTests: [], labValues: [], documents: [] }} unitSystem="si"
        sex="male" grading={knownMinor ? null : { sex: 'male' }} onSave={() => {}} onCancel={() => {}} isSaving={false} error={null} />,
    );
    const row = container.querySelector('.review-matrix .bt-row:not(.bt-header-row)')!;
    const colours = [...row.querySelectorAll('.bt-status-tick')].map(t => t.className.replace('bt-status-tick ', ''))
      .filter(c => c !== 'bt-status-none');
    return { hint: row.querySelector('.bt-ref-label')?.textContent ?? null, colours, value: row.querySelector('input')!.value };
  }

  it('an adult: the hint and the colour', () => {
    const r = ldlRow(false);
    expect(r.hint).not.toBeNull();
    expect(r.colours).not.toEqual([]);
  });

  it('a known minor: the value, with no hint and no colour', () => {
    expect(ldlRow(true)).toEqual({ hint: null, colours: [], value: '4.0' });
  });
});
