// @vitest-environment jsdom
/**
 * US-05 AC2: Lp(a)'s three-unit control is a radio group a keyboard can
 * drive: one tab stop (the checked unit), arrow keys move and select,
 * wrapping at either end, and the group has a name.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import type { LpaUnit } from '@roadmap/health-core';
import { LpaUnitControl } from './LpaUnitControl';

afterEach(cleanup);

function Harness({ start, chosen }: { start: LpaUnit; chosen: LpaUnit[] }) {
  const [unit, setUnit] = useState(start);
  return <LpaUnitControl unit={unit} onChange={(u) => { chosen.push(u); setUnit(u); }}/>;
}

function control(start: LpaUnit = 'mg/dL') {
  const chosen: LpaUnit[] = [];
  const view = render(<Harness start={start} chosen={chosen}/>);
  const group = within(view.container).getByRole('radiogroup', { name: 'Lp(a) unit' });
  const radio = (name: string) => within(group).getByRole('radio', { name });
  const checked = () => within(group).getByRole('radio', { checked: true }).textContent;
  const tabStops = () => within(group).getAllByRole('radio').filter((r) => r.tabIndex === 0).map((r) => r.textContent);
  const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
  return { group, radio, checked, tabStops, press, chosen };
}

describe('US-05 AC2 — the Lp(a) unit control by keyboard', () => {
  it('is a named radio group with one tab stop, the checked unit', () => {
    const c = control('mg/dL');
    expect(c.tabStops()).toEqual(['mg/dL']);
    expect(c.radio('nmol/L').tabIndex).toBe(-1);
    expect(c.radio('mg/L').tabIndex).toBe(-1);
  });

  it('Right and Down move to the next unit and select it; the tab stop follows', () => {
    const c = control('nmol/L');
    c.radio('nmol/L').focus();
    c.press('ArrowRight');
    expect(c.checked()).toBe('mg/dL');
    expect(document.activeElement).toBe(c.radio('mg/dL'));
    expect(c.tabStops()).toEqual(['mg/dL']);
    c.press('ArrowDown');
    expect(c.checked()).toBe('mg/L');
    expect(document.activeElement).toBe(c.radio('mg/L'));
    expect(c.chosen).toEqual(['mg/dL', 'mg/L']);
  });

  it('Left and Up move back; both ends wrap', () => {
    const c = control('nmol/L');
    c.radio('nmol/L').focus();
    c.press('ArrowLeft');
    expect(c.checked()).toBe('mg/L');
    expect(document.activeElement).toBe(c.radio('mg/L'));
    c.press('ArrowUp');
    expect(c.checked()).toBe('mg/dL');
    c.press('ArrowRight');
    c.press('ArrowRight');
    expect(c.checked()).toBe('nmol/L');
    expect(c.chosen).toEqual(['mg/L', 'mg/dL', 'mg/L', 'nmol/L']);
  });

  it('other keys do nothing; a click still chooses', () => {
    const c = control('mg/dL');
    c.radio('mg/dL').focus();
    c.press('a');
    c.press('Tab');
    expect(c.chosen).toEqual([]);
    fireEvent.click(c.radio('nmol/L'));
    expect(c.checked()).toBe('nmol/L');
    expect(c.chosen).toEqual(['nmol/L']);
  });
});
