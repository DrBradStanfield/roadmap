// @vitest-environment jsdom
/**
 * US-07 AC3 on My health (US-62 AC28): a new or changed suggestion glows, then
 * fades, on its calm card and on its row. The glow is one soft teal tint, not
 * the priority's colour; the page's real stylesheet decides what shows.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { calculateHealthResults } from '@roadmap/health-core/calculations';
import { statTiles } from '@roadmap/health-core/stat-tiles';
import type { HealthInputs } from '@roadmap/health-core/types';

vi.mock('../lib/roadmap-data', () => ({
  getReportHtml: vi.fn(), sendGuestReport: vi.fn(), getReportEmailCaptured: () => false, markReportEmailCaptured: vi.fn(),
}));
vi.mock('../lib/server-api', () => ({ trackABConversion: vi.fn(), trackProductEvent: vi.fn() }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: false }));
vi.mock('../lib/assistant-config', () => ({ getSkipEmailGate: () => false }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
import { PlanHost } from '../testing/plan-host';
import { RowSuggestions } from './ResultsPanel';

const TEAL = 'rgba(0, 163, 139, 0.08)';
beforeAll(() => {
  const style = document.createElement('style');
  style.textContent = readFileSync(resolve(__dirname, '../styles.css'), 'utf8');
  document.head.appendChild(style);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

// Synthetic: LDL alone, then an HbA1c in the diabetic range joins it.
const BEFORE: HealthInputs = { heightCm: 175, sex: 'male', birthYear: 1970, birthMonth: 1, weightKg: 80, ldlC: 4.9 };
const AFTER: HealthInputs = { ...BEFORE, hba1c: 50 };
const host = (inputs: HealthInputs) => {
  const results = calculateHealthResults(inputs)!;
  return <div className="health-tool"><PlanHost results={results} isValid tiles={statTiles(results, { unitSystem: 'si' })}/></div>;
};

it('US-07 AC3: a new suggestion\'s calm card glows teal, then fades; the others do not', () => {
  vi.useFakeTimers();
  const view = render(host(BEFORE));
  act(() => { vi.advanceTimersByTime(3100); }); // the plan has settled
  view.rerender(host(AFTER));
  // New, or its words changed: the ones that glow.
  const was = new Map(calculateHealthResults(BEFORE)!.suggestions.map(s => [s.id, s.title + s.description]));
  const changed = new Set(calculateHealthResults(AFTER)!.suggestions.filter(s => was.get(s.id) !== s.title + s.description).map(s => s.title));
  const cards = [...view.container.querySelectorAll<HTMLElement>('.suggestion-card:not(.grouped-card)')];
  const fresh = cards.filter(c => changed.has(c.querySelector('.suggestion-title')!.textContent!));
  expect(fresh.length).toBeGreaterThan(0);
  expect(fresh.length).toBeLessThan(cards.length);
  for (const card of cards) {
    const glowing = fresh.includes(card);
    expect(card.classList.contains('suggestion-highlight'), card.textContent!).toBe(glowing);
    expect(getComputedStyle(card).backgroundColor).toBe(glowing ? TEAL : 'rgb(255, 255, 255)');
  }
  act(() => { vi.advanceTimersByTime(3000); });
  expect(fresh[0].classList.contains('suggestion-fade-out')).toBe(true);
  expect(getComputedStyle(fresh[0]).animation).toContain('mh-glow-out');
});

it('US-07 AC3: a suggestion on a row glows teal too, then fades', () => {
  const s = calculateHealthResults(AFTER)!.suggestions.find(x => x.priority === 'urgent')!;
  const row = (fading: boolean) => (
    <div className="health-tool">
      <RowSuggestions suggestions={[s]} highlights={{ highlighted: new Set(fading ? [] : [s.id]), fadingOut: new Set(fading ? [s.id] : []) }}/>
    </div>
  );
  const view = render(row(false));
  const line = view.container.querySelector<HTMLElement>('.mh-row-suggestion')!;
  expect(getComputedStyle(line).backgroundColor).toBe(TEAL);
  view.rerender(row(true));
  expect(getComputedStyle(line).animation).toContain('mh-glow-out');
  view.rerender(<div className="health-tool"><RowSuggestions suggestions={[s]} highlights={{ highlighted: new Set(), fadingOut: new Set() }}/></div>);
  expect(line.classList.contains('suggestion-highlight')).toBe(false);
});

it.each([['glows', 1000, '.suggestion-highlight:not(.suggestion-fade-out)'], ['fades', 3200, '.suggestion-fade-out']])('US-07 AC3: a change undone while its card %s ends the glow', (_, undoAt, phase) => {
  vi.useFakeTimers();
  const view = render(host(BEFORE));
  act(() => { vi.advanceTimersByTime(3100); }); // the plan has settled
  view.rerender(host(AFTER));
  expect(view.container.querySelector('.suggestion-highlight')).not.toBeNull();
  act(() => { vi.advanceTimersByTime(undoAt); });
  expect(view.container.querySelector(phase)).not.toBeNull(); // the phase this case undoes in
  view.rerender(host(BEFORE)); // undone: nothing is new against the settled plan
  expect(view.container.querySelector('.suggestion-highlight, .suggestion-fade-out')).toBeNull(); // at once
  act(() => { vi.advanceTimersByTime(10_000); });
  expect(view.container.querySelector('.suggestion-highlight, .suggestion-fade-out')).toBeNull();
});
