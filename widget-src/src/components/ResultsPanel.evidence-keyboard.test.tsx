// @vitest-environment jsdom
/**
 * US-07 AC16: a card's evidence opens from the keyboard. "Why this suggestion?"
 * and a snapshot tile with evidence take the focus, say whether they are open,
 * and Enter or Space opens and closes them as a click does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { calculateHealthResults } from '@roadmap/health-core/calculations';
import { statTiles } from '@roadmap/health-core/stat-tiles';
import type { HealthInputs } from '@roadmap/health-core/types';

vi.mock('../lib/roadmap-data', () => ({
  getReportHtml: vi.fn(), sendGuestReport: vi.fn(), getReportEmailCaptured: () => false, markReportEmailCaptured: vi.fn(), getShownErase: () => 'erase-1',
}));
vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/build-flags', () => ({ SHOPIFY_SURFACE: false }));
vi.mock('../lib/assistant-config', () => ({ getSkipEmailGate: () => false }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
import { PlanHost as ResultsPanel } from '../testing/plan-host';
import { PlanTile } from './PlanCards';

afterEach(cleanup);

// Synthetic: high LDL and blood pressure, so cards and the LDL tile carry evidence.
const inputs: HealthInputs = { heightCm: 175, sex: 'male', birthYear: 1970, birthMonth: 1, weightKg: 95, waistCm: 104, systolicBp: 150, diastolicBp: 95, ldlC: 4.9 };
function plan() {
  const results = calculateHealthResults(inputs)!;
  const view = render(<ResultsPanel results={results} isValid tiles={statTiles(results, { unitSystem: 'si' })} />);
  return view;
}
/** fireEvent returns false when a handler called preventDefault. */
const key = (el: Element, k: string) => fireEvent.keyDown(el, { key: k });

describe('US-07 AC16: "Why this suggestion?" from the keyboard', () => {
  it('is a focusable control that says it is closed', () => {
    const view = plan();
    const toggles = view.getAllByRole('button', { name: /Why this suggestion\?/ });
    expect(toggles.length).toBeGreaterThan(1);
    for (const t of toggles) {
      expect(t.tabIndex).toBe(0);
      expect(t.getAttribute('aria-expanded')).toBe('false');
    }
  });

  it('Enter opens the reason and references, Space closes them, and both keep their default from the page', () => {
    const view = plan();
    const toggle = view.getAllByRole('button', { name: /Why this suggestion\?/ })[0];
    const section = toggle.closest('.suggestion-evidence-section') as HTMLElement;
    expect(section.querySelector('.evidence-content')).toBeNull();
    expect(key(toggle, 'Enter')).toBe(false);
    expect(section.querySelector('.evidence-content')).not.toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(key(toggle, ' ')).toBe(false);
    expect(section.querySelector('.evidence-content')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('another key does nothing, and a click still opens it', () => {
    const view = plan();
    const toggle = view.getAllByRole('button', { name: /Why this suggestion\?/ })[0];
    const section = toggle.closest('.suggestion-evidence-section') as HTMLElement;
    expect(key(toggle, 'a')).toBe(true);
    expect(key(toggle, 'Tab')).toBe(true);
    expect(section.querySelector('.evidence-content')).toBeNull();
    fireEvent.click(toggle);
    expect(section.querySelector('.evidence-content')).not.toBeNull();
  });
});

describe('US-07 AC16: a snapshot tile with evidence from the keyboard', () => {
  const tile = (view: ReturnType<typeof plan>, label: string) => Array.from(view.container.querySelectorAll<HTMLElement>('.stat-card'))
    .find((c) => c.querySelector('.stat-label')?.textContent === label)!;

  it('the LDL tile is a focusable control that Enter and Space open and close', () => {
    const view = plan();
    const ldl = tile(view, 'LDL Cholesterol');
    const control = within(ldl).getByRole('button'); // the tile's title (US-07 AC16a)
    expect(control.tabIndex).toBe(0);
    // The focus stop is the title alone; the tile itself is no control.
    expect(ldl.hasAttribute('tabindex')).toBe(false);
    expect(ldl.hasAttribute('aria-expanded')).toBe(false);
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(key(control, 'Enter')).toBe(false);
    expect(ldl.querySelector('.stat-detail')).not.toBeNull();
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(key(control, ' ')).toBe(false);
    expect(ldl.querySelector('.stat-detail')).toBeNull();
    expect(key(control, 'a')).toBe(true);
    expect(ldl.querySelector('.stat-detail')).toBeNull();
  });

  it("Enter or Space on a reference link inside an open tile is left to the link, and the link's click closes the tile", () => {
    const view = plan();
    const ldl = tile(view, 'LDL Cholesterol');
    fireEvent.click(ldl);
    const link = within(ldl).getAllByRole('link')[0];
    // The tile's key handler leaves the key and its default to the link.
    expect(key(link, 'Enter')).toBe(true);
    expect(key(link, ' ')).toBe(true);
    // jsdom fires no click for those keys; a browser does, and it bubbles to the
    // tile. That click closes the tile, as a mouse click on the link does.
    fireEvent.click(link);
    expect(ldl.querySelector('.stat-detail')).toBeNull();
  });

  it('a tile without evidence stays plain', () => {
    const view = plan();
    const plain = Array.from(view.container.querySelectorAll<HTMLElement>('.stat-card')).filter((c) => !c.classList.contains('stat-card-clickable'));
    expect(plain.length).toBeGreaterThan(0);
    for (const c of plain) {
      expect(c.getAttribute('role')).toBeNull();
      expect(within(c).queryByRole('button')).toBeNull();
      expect(c.querySelector('[aria-labelledby]')).toBeNull();
      expect(c.hasAttribute('tabindex')).toBe(false);
      expect(c.querySelector('[tabindex]')).toBeNull();
      expect(c.hasAttribute('aria-expanded')).toBe(false);
      expect(key(c, 'Enter')).toBe(true);
      expect(c.querySelector('.stat-detail')).toBeNull();
    }
  });
});

describe("US-07 AC16a: an open tile's links are not inside its button", () => {
  const ldlButton = (view: ReturnType<typeof plan>) => view.getByRole('button', { name: /^LDL Cholesterol/ });

  it("the open tile's links stay links outside every button, and its button names only the tile", () => {
    const view = plan();
    const button = ldlButton(view);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(key(button, 'Enter')).toBe(false);
    const tile = button.closest('.stat-card') as HTMLElement;
    expect(within(tile).getAllByRole('link').length).toBeGreaterThan(0);
    for (const b of view.getAllByRole('button')) expect(within(b).queryAllByRole('link')).toHaveLength(0);
    const name = 'LDL Cholesterol 4.9 mmol/L High';
    expect(view.getByRole('button', { name, expanded: true })).toBe(button);
    expect(key(button, ' ')).toBe(false);
    expect(view.getByRole('button', { name, expanded: false })).toBe(button);
    expect(tile.querySelector('.stat-detail')).toBeNull();
  });

  it('a tile with evidence and no status is named by its title and value', () => {
    const evidence = { reason: 'Synthetic reason.', guidelines: [], references: [{ label: 'Synthetic ref', url: 'https://example.org/ref' }] };
    const view = render(<PlanTile tile={{ key: 'bmi', label: 'Synthetic Tile', value: '7', unit: 'u', about: 'Synthetic.', evidence }}/>);
    expect(view.container.querySelector('.stat-status')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Synthetic Tile 7 u', expanded: false }));
    expect(view.getByRole('link', { name: 'Synthetic ref' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'Synthetic Tile 7 u', expanded: true })).toBeTruthy();
  });

  it('a click anywhere on the tile still opens and closes it', () => {
    const view = plan();
    const tile = ldlButton(view).closest('.stat-card') as HTMLElement;
    fireEvent.click(tile.querySelector('.stat-value')!);
    expect(tile.querySelector('.stat-detail')).not.toBeNull();
    fireEvent.click(ldlButton(view));
    expect(tile.querySelector('.stat-detail')).toBeNull();
  });
});

describe('US-07 AC16: the printed plan keeps them', () => {
  // The PDF's copy of the plan is drawn only while Save as PDF copies it (US-62 AC26).
  it('the PDF snapshot, which drops buttons, still holds the tiles and the toggles', async () => {
    const { getReportHtml: real } = await vi.importActual<typeof import('../lib/roadmap-data')>('../lib/roadmap-data');
    const { getReportHtml } = await import('../lib/roadmap-data');
    let html = '';
    vi.mocked(getReportHtml).mockImplementation(real);
    vi.stubGlobal('open', () => ({ document: { write: (h: string) => { html = h; }, close() {} }, print() {} }));
    const view = plan();
    expect(view.container.querySelector('.health-results-panel')).toBeNull(); // not drawn on screen
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await vi.waitFor(() => expect(html).not.toBe(''));
    vi.unstubAllGlobals();
    expect(view.container.querySelector('.health-results-panel')).toBeNull();
    const printed = new DOMParser().parseFromString(html, 'text/html');
    expect(Array.from(printed.querySelectorAll('.stat-label')).map((l) => l.textContent)).toContain('LDL Cholesterol');
    expect(printed.querySelectorAll('.evidence-toggle').length).toBeGreaterThan(1);
  });
});

// US-62 AC28, review re-check: which reasons are open is the screen's and its PDF's,
// and an erase forgets it with the record.
it('Delete all my data closes every opened reason', async () => {
  const results = calculateHealthResults(inputs)!;
  const view = render(<ResultsPanel results={results} isValid tiles={statTiles(results, { unitSystem: 'si' })} onDeleteData={async () => true}/>);
  fireEvent.click(view.getAllByRole('button', { name: /Why this suggestion\?/ })[0]);
  expect(view.container.querySelectorAll('.evidence-content')).toHaveLength(1);
  fireEvent.click(view.getByRole('button', { name: 'Delete all my data' }));
  await waitFor(() => expect(view.container.querySelectorAll('.evidence-content')).toHaveLength(0));
});

// US-09 AC19: any erase the screen shows (another device's, once re-read, or one
// whose write failed but still erased) closes them too, not only a successful Delete here.
it('an erase the screen shows without a Delete here closes every opened reason', () => {
  const results = calculateHealthResults(inputs)!;
  const tiles = statTiles(results, { unitSystem: 'si' });
  const view = render(<ResultsPanel results={results} isValid tiles={tiles} shownErase="e1"/>);
  fireEvent.click(view.getAllByRole('button', { name: /Why this suggestion\?/ })[0]);
  view.rerender(<ResultsPanel results={results} isValid tiles={tiles} shownErase="e1"/>);
  expect(view.container.querySelectorAll('.evidence-content')).toHaveLength(1);
  view.rerender(<ResultsPanel results={results} isValid tiles={tiles} shownErase="e2"/>);
  expect(view.container.querySelectorAll('.evidence-content')).toHaveLength(0);
});

