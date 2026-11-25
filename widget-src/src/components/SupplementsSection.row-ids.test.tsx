// @vitest-environment jsdom
/** US-09 AC7k: row element ids come from the row's place, not its key.
 * A row's name shows as text and sits in no attribute value.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { customSupplementAdd } from '@roadmap/health-core/input-form';
import type { ApiSupplement } from '../lib/api-types';
import { labSlotKey } from '@roadmap/health-core/lab-catalog';
import { SupplementsSection } from './SupplementsSection';
import { MetricRows, type RowModel } from './MyDataRows';

const NAME = 'Quillfeather Tonic';

function attributeValues(root: Element): string[] {
  return [root, ...root.querySelectorAll('*')].flatMap(el => [...el.attributes].map(a => a.value));
}

describe('US-09 AC7k: supplement row ids', () => {
  afterEach(cleanup);

  it('puts a custom name in the visible text and in no attribute, with the dose error still linked', () => {
    const { supplementKey, supplementName } = customSupplementAdd(NAME, []);
    const supplements = [
      { supplementKey, supplementName, doseValue: 5, doseUnit: 'mg', status: 'active' },
      { supplementKey: 'custom_other_one', supplementName: 'Other one', doseValue: 1, doseUnit: 'mg', status: 'active' },
    ] as ApiSupplement[];
    const { container } = render(<SupplementsSection supplements={supplements} onSupplementChange={() => {}} onSupplementDelete={() => {}}/>);
    const doses = container.querySelectorAll<HTMLInputElement>('.supplement-dose');
    fireEvent.change(doses[0], { target: { value: '-5' } });
    fireEvent.change(doses[1], { target: { value: '0' } });

    expect(container.textContent).toContain(NAME);
    const leaked = attributeValues(container).filter(v => /quillfeather/i.test(v));
    expect(leaked).toEqual([]);

    // Each dose still names its own error, and the two ids differ.
    const errors = [...doses].map(d => d.getAttribute('aria-describedby'));
    expect(errors[0]).toBeTruthy();
    expect(errors[1]).toBeTruthy();
    expect(errors[0]).not.toBe(errors[1]);
    for (const id of errors) expect(container.ownerDocument.getElementById(id!)?.getAttribute('role')).toBe('alert');
  });
});

describe('US-09 AC7k: My data rows', () => {
  afterEach(cleanup);

  it('puts a lab test the catalogue does not know in the visible text and in no attribute', () => {
    const row: RowModel = {
      subject: { kind: 'lab', seriesKey: labSlotKey(NAME) }, label: NAME, target: null, day: '2026-05-10',
      latest: '4.2', previous: null, unit: 'U/L', trend: [4.2], tint: '#e5484d', status: null, graded: NAME,
    };
    const { container } = render(<MetricRows rows={[row]} onOpen={() => {}}/>);
    expect(container.textContent).toContain(NAME);
    expect(attributeValues(container).filter(v => /quillfeather/i.test(v))).toEqual([]);
  });
});
