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
