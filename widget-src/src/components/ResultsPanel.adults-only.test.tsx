// @vitest-environment jsdom
/**
 * US-07 AC6 (2026-10-14): under 18 the plan is one card, "This plan is built
 * for adults". It renders as a plan, not an empty state: the one card under
 * its group heading, no empty group, and the measured values still shown.
 * Amended 2026-10-14: the tiles keep the raw values and drop every adult
 * reading of them (BMI category, ideal body weight, protein target, eGFR, the
 * lipid, HbA1c and Lp(a) labels), leaving no empty box. With no birth year,
 * the medicine cards give way to one "Add your birth year" card.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { calculateHealthResults } from '@roadmap/health-core';

vi.mock('../lib/roadmap-data', () => ({
  getReportHtml: vi.fn(), sendGuestReport: vi.fn(), getReportEmailCaptured: () => false, markReportEmailCaptured: vi.fn(),
}));
vi.mock('../lib/server-api', () => ({ trackABConversion: vi.fn(), trackProductEvent: vi.fn() }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
import { ResultsPanel } from './ResultsPanel';

afterEach(cleanup);

describe('US-07 AC6: a plan holding only the adults-only card', () => {
  it('renders the one card under one heading, with no empty group and the values still shown', () => {
    // Ten years old on any clock.
    const results = calculateHealthResults({ heightCm: 150, sex: 'female', weightKg: 45, birthYear: new Date().getFullYear() - 10 });
    const { container } = render(<ResultsPanel results={results} isValid unitSystem="si" />);

    const cards = container.querySelectorAll('.suggestion-card');
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector('.suggestion-title')?.textContent).toBe('This plan is built for adults');
    expect(cards[0].querySelector('.suggestion-desc')?.textContent).toContain('aged 18 and over');
    expect(container.querySelectorAll('.suggestions-group')).toHaveLength(1);
    expect(container.querySelector('.plan-empty-preview')).toBeNull();
    expect(container.querySelector('.skin-group, .supplements-group')).toBeNull();
    // The record is untouched: the measured tiles still render.
    expect(Array.from(container.querySelectorAll('.stat-label')).map((l) => l.textContent)).toContain('BMI');
  });
});

describe('US-07 AC6: a minor\'s tiles hold values, not adult readings', () => {
  it('BMI, LDL, HbA1c and Lp(a) show their numbers with no status; ideal weight, protein and eGFR are gone; no box is empty', () => {
    // Ten years old on any clock: the widget computes age against today.
    const results = calculateHealthResults({
      heightCm: 150, sex: 'female', weightKg: 60, birthYear: new Date().getFullYear() - 10,
      ldlC: 4.9, hba1c: 50, lpa: 200, creatinine: 60,
    });
    const { container } = render(<ResultsPanel results={results} isValid unitSystem="si" />);

    const tiles = Array.from(container.querySelectorAll('.stat-card'));
    const byLabel = new Map(tiles.map((t) => [t.querySelector('.stat-label')?.textContent, t]));
    expect([...byLabel.keys()]).toEqual(['BMI', 'LDL Cholesterol', 'Lp(a)', 'HbA1c']);
    expect(byLabel.get('BMI')?.querySelector('.stat-value')?.textContent).toBe('26.7');
    expect(byLabel.get('LDL Cholesterol')?.querySelector('.stat-value')?.textContent).toBe('4.9 mmol/L');
    expect(byLabel.get('Lp(a)')?.querySelector('.stat-value')?.textContent).toBe('200 nmol/L');
    expect(byLabel.get('HbA1c')?.querySelector('.stat-value')?.textContent).toBe('50 mmol/mol');
    expect(container.querySelectorAll('.stat-status')).toHaveLength(0);
    for (const tile of tiles) {
      expect(tile.querySelector('.stat-value')?.textContent?.trim()).not.toBe('');
      // No "Why?" expansion: each one explains an adult reading.
      expect(tile.classList.contains('stat-card-clickable')).toBe(false);
    }
  });

  it('an adult with the same values keeps every reading', () => {
    const results = calculateHealthResults({
      heightCm: 150, sex: 'female', weightKg: 60, birthYear: new Date().getFullYear() - 40,
      ldlC: 4.9, hba1c: 50, lpa: 200, creatinine: 60,
    });
    const { container } = render(<ResultsPanel results={results} isValid unitSystem="si" />);
    const labels = Array.from(container.querySelectorAll('.stat-label')).map((l) => l.textContent);
    expect(labels).toEqual(expect.arrayContaining(['BMI', 'Ideal Body Weight (IBW)', 'Protein Target', 'LDL Cholesterol', 'eGFR', 'Lp(a)', 'HbA1c']));
    expect(container.querySelectorAll('.stat-status').length).toBeGreaterThanOrEqual(6);
  });
});

describe('US-07 AC6: with no birth year, one card in place of the medicines', () => {
  it('renders "Add your birth year" once, and no medication card', () => {
    const results = calculateHealthResults({ heightCm: 175, sex: 'male', weightKg: 115, waistCm: 115, ldlC: 4.9 }, 'si', {});
    const { container } = render(<ResultsPanel results={results} isValid unitSystem="si" />);
    const titles = Array.from(container.querySelectorAll('.suggestion-title')).map((t) => t.textContent);
    expect(titles.filter((t) => t === 'Add your birth year')).toHaveLength(1);
    expect(titles).not.toContain('Consider starting a statin');
    expect(titles).not.toContain('Consider a GLP-1 medication');
    const card = Array.from(container.querySelectorAll('.suggestion-title')).find((t) => t.textContent === 'Add your birth year')!;
    expect(card.parentElement?.querySelector('.suggestion-desc')?.textContent).toBe('Medicine suggestions need your age. Add your birth year to see them.');
    expect(container.querySelector('.suggestion-badge.suggestion-info')?.textContent).toBeTruthy();
  });
});


// Adversary R4 (2026-10-14): the reminders section offered a known minor
// "Turn on email health reminders" and the MicroVitamin mailing-list box.
describe('US-07 AC6: no reminders section for a known minor', () => {
  const section = <section data-testid="reminders">Turn on email health reminders</section>;

  it('a known minor sees no reminders section', () => {
    const results = calculateHealthResults({ heightCm: 150, sex: 'female', weightKg: 45, birthYear: new Date().getFullYear() - 10 });
    const { queryByTestId } = render(<ResultsPanel results={results} isValid unitSystem="si" remindersSection={section} />);
    expect(queryByTestId('reminders')).toBeNull();
  });

  it('an adult and an unknown age still see it', () => {
    for (const birthYear of [new Date().getFullYear() - 40, undefined]) {
      const results = calculateHealthResults({ heightCm: 150, sex: 'female', weightKg: 60, ...(birthYear ? { birthYear } : {}) });
      const { queryByTestId, unmount } = render(<ResultsPanel results={results} isValid unitSystem="si" remindersSection={section} />);
      expect(queryByTestId('reminders')).not.toBeNull();
      unmount();
    }
  });
});
