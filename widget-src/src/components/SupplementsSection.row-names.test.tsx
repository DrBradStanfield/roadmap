// @vitest-environment jsdom
/** US-06 AC1c: each supplement row's dose box, unit select and remove button name the supplement they belong to, so
 *  with two rows a screen reader or voice control can tell them apart. Synthetic supplements. */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
