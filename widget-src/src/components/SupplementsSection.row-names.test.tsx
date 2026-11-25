// @vitest-environment jsdom
/** US-06 AC1c: each supplement row's dose box, unit select and remove button name the supplement they belong to, so
 *  with two rows a screen reader or voice control can tell them apart. The names come from aria-labelledby, and no
 *  attribute holds the supplement's name or key (per the maintainer's review). Synthetic supplements. */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { customSupplementAdd } from '@roadmap/health-core/input-form';
import { SupplementsSection } from './SupplementsSection';
import type { ApiSupplement } from '../lib/api-types';

afterEach(cleanup);

const row = (supplementKey: string, supplementName: string, doseValue: number | null, doseUnit: string | null, status = 'active'): ApiSupplement =>
  ({ id: `s-${supplementKey}`, supplementKey, supplementName, doseValue, doseUnit, status, startedAt: null, updatedAt: '2026-01-02T00:00:00.000Z' });

const renderRows = (supplements: ApiSupplement[]) => {
  const onSupplementChange = vi.fn();
  const onSupplementDelete = vi.fn();
  render(<SupplementsSection supplements={supplements} onSupplementChange={onSupplementChange} onSupplementDelete={onSupplementDelete}/>);
  return { onSupplementChange, onSupplementDelete };
};

it('US-06 AC1c: two rows name their dose, unit and remove controls after their own supplement', () => {
  renderRows([row('vitamin_d', 'Vitamin D', 2000, 'IU'), row('creatine', 'Creatine', 5, 'g')]);
  expect((screen.getByRole('spinbutton', { name: 'Vitamin D dose' }) as HTMLInputElement).value).toBe('2000');
  expect((screen.getByRole('spinbutton', { name: 'Creatine dose' }) as HTMLInputElement).value).toBe('5');
  expect((screen.getByRole('combobox', { name: 'Vitamin D dose unit' }) as HTMLSelectElement).value).toBe('IU');
  expect((screen.getByRole('combobox', { name: 'Creatine dose unit' }) as HTMLSelectElement).value).toBe('g');
  screen.getByRole('button', { name: 'Remove Vitamin D' });
  screen.getByRole('button', { name: 'Remove Creatine' });
  expect(screen.queryByRole('button', { name: '×' })).toBeNull(); // the glyph is no longer the name
});

it('US-06 AC1c: the named controls act on their own row', () => {
  const { onSupplementChange, onSupplementDelete } = renderRows([row('vitamin_d', 'Vitamin D', 2000, 'IU'), row('creatine', 'Creatine', 5, 'g')]);
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Creatine dose' }), { target: { value: '3' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Vitamin D dose unit' }), { target: { value: 'mcg' } });
  fireEvent.click(screen.getByRole('button', { name: 'Remove Creatine' }));
  expect(onSupplementChange.mock.calls).toEqual([['creatine', 'Creatine', 3, 'g'], ['vitamin_d', 'Vitamin D', 2000, 'mcg']]);
  expect(onSupplementDelete.mock.calls).toEqual([['creatine']]);
});

it('US-06 AC1c: a custom name and an empty dose and unit are named the same way; a stopped supplement has no row', () => {
  renderRows([row('custom_beta_alanine', 'β-alanine', null, null), row('creatine', 'Creatine', 5, 'g', 'stopped')]);
  expect((screen.getByRole('spinbutton', { name: 'β-alanine dose' }) as HTMLInputElement).value).toBe('');
  expect((screen.getByRole('combobox', { name: 'β-alanine dose unit' }) as HTMLSelectElement).value).toBe('');
  screen.getByRole('button', { name: 'Remove β-alanine' });
  expect(screen.queryByRole('button', { name: /Creatine/ })).toBeNull();
});

it('US-06 AC1c: an unsaved dose keeps its error as the box\'s description under the new name', () => {
  renderRows([row('vitamin_d', 'Vitamin D', 2000, 'IU')]);
  const dose = screen.getByRole('spinbutton', { name: 'Vitamin D dose' });
  fireEvent.change(dose, { target: { value: '0' } });
  expect(document.getElementById(dose.getAttribute('aria-describedby')!)?.textContent).toBe('Enter a dose greater than 0 and no more than 99999. This dose was not saved.');
  expect(dose.getAttribute('aria-invalid')).toBe('true');
});

const allAttributes = (root: Element) =>
  [root, ...root.querySelectorAll('*')].flatMap(el => [...el.attributes].map(a => ({ tag: el.tagName, attr: a.name, value: a.value })));

it('US-06 AC1c: the row controls take their names from aria-labelledby, and no attribute holds the name or the key', () => {
  const NAME = 'Zephyrwort Elixir';
  const { supplementKey } = customSupplementAdd(NAME, []);
  expect(supplementKey).toMatch(/zephyrwort/); // the key is distinctive too, so the scan below covers it
  const { container } = render(<SupplementsSection onSupplementChange={vi.fn()} onSupplementDelete={vi.fn()} supplements={[
    row(supplementKey, NAME, 7, 'mg'), row('creatine', 'Creatine', 5, 'g'),
  ]}/>);
  const dose = screen.getByRole('spinbutton', { name: 'Zephyrwort Elixir dose' });
  fireEvent.change(dose, { target: { value: '0' } }); // the dose error's id and aria-describedby are in the scan too
  const unit = screen.getByRole('combobox', { name: 'Zephyrwort Elixir dose unit' });
  const remove = screen.getByRole('button', { name: 'Remove Zephyrwort Elixir' });
  expect(container.querySelector('.supplement-name')?.textContent).toBe(NAME); // still shown as text
  const leaked = allAttributes(container).filter(({ value }) => {
    const v = value.toLowerCase();
    return v.includes(NAME.toLowerCase()) || v.includes(supplementKey.toLowerCase()) || v.includes('zephyrwort') || v.includes('elixir');
  });
  expect(leaked).toEqual([]);
  for (const control of [dose, unit, remove]) {
    expect(control.hasAttribute('aria-label')).toBe(false);
    expect(control.getAttribute('aria-labelledby')).toMatch(/\S+ \S+/);
  }
});

it('US-06 AC1c: two rows with the same name get distinct ids, each control labelled by its own row\'s name', () => {
  const { container } = render(<SupplementsSection onSupplementChange={vi.fn()} onSupplementDelete={vi.fn()} supplements={[
    row('custom_twin_a', 'Twin', 1, 'mg'), row('custom_twin_b', 'Twin', 2, 'g'),
  ]}/>);
  expect(screen.getAllByRole('spinbutton', { name: 'Twin dose' })).toHaveLength(2);
  expect(screen.getAllByRole('combobox', { name: 'Twin dose unit' })).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: 'Remove Twin' })).toHaveLength(2);
  const ids = [...container.querySelectorAll('[id]')].map(el => el.id);
  expect(new Set(ids).size).toBe(ids.length);
  const nameIds = [...container.querySelectorAll('.supplement-name')].map(el => el.id);
  expect(nameIds).toHaveLength(2);
  expect(nameIds[0]).not.toBe(nameIds[1]);
  container.querySelectorAll('.supplement-row').forEach((rowEl, i) => {
    for (const control of rowEl.querySelectorAll('input, select, button')) {
      const refs = control.getAttribute('aria-labelledby')!.split(' ');
      expect(refs).toContain(nameIds[i]);
      // The fixed word is not shown: each other element it lists is hidden.
      for (const ref of refs.filter(r => r !== nameIds[i])) expect(document.getElementById(ref)?.hidden).toBe(true);
    }
  });
  // A second list on the same page gets its own ids too.
  render(<SupplementsSection onSupplementChange={vi.fn()} onSupplementDelete={vi.fn()} supplements={[row('custom_twin_a', 'Twin', 1, 'mg')]}/>);
  const pageIds = [...document.querySelectorAll('[id]')].map(el => el.id);
  expect(new Set(pageIds).size).toBe(pageIds.length);
  expect(screen.getAllByRole('button', { name: 'Remove Twin' })).toHaveLength(3);
});
