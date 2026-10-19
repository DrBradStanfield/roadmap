// @vitest-environment jsdom
// US-13 AC8: a date cell with no day yet starts with an EMPTY picker. Picking
// a prefilled picker's own day fires no change, so that day (often the 1st
// it was filled with) could never be chosen.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { DraftDateCell } from './DraftDateCell';

afterEach(cleanup);

describe('DraftDateCell: a missing day starts empty (US-13 AC8)', () => {
  it('needsDay: the picker is empty, the cell reads "— Mon \'YY", and the month\'s 1st can be picked', () => {
    const onChange = vi.fn();
    const view = render(<DraftDateCell date="2024-06-01" needsDay onChange={onChange} ariaLabel="Pick" />);
    const input = view.getByLabelText('Pick') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(view.container.textContent).toContain('— Jun');
    expect(view.container.textContent).toContain("'24");
    fireEvent.change(input, { target: { value: '2024-06-01' } });
    expect(onChange).toHaveBeenCalledWith('2024-06-01');
  });

  it('needsDay with a placeholder: shows it instead of a date, even with no date at all', () => {
    const view = render(<DraftDateCell date="" needsDay placeholder="Pick a day in Jun 2024" onChange={() => {}} ariaLabel="Pick" />);
    expect(view.container.textContent).toContain('Pick a day in Jun 2024');
    expect(view.container.textContent).not.toContain('NaN');
    expect((view.getByLabelText('Pick') as HTMLInputElement).value).toBe('');
  });

  it('a known day stays prefilled, and the placeholder is ignored', () => {
    const view = render(<DraftDateCell date="2024-06-12" placeholder="unused" onChange={() => {}} ariaLabel="Pick" />);
    expect((view.getByLabelText('Pick') as HTMLInputElement).value).toBe('2024-06-12');
    expect(view.container.textContent).toContain('12 Jun');
    expect(view.container.textContent).not.toContain('unused');
  });

  it('is one element, so a matrix column stays one flex child', () => {
    const view = render(<DraftDateCell date="" needsDay placeholder="Pick a day" onChange={() => {}} />);
    expect(view.container.children).toHaveLength(1);
  });
});
