// @vitest-environment jsdom
/**
 * US-62 phase 5 (AC16 to AC26): My health, the web's one tab of numbers and
 * plan, the iPhone's (US-73). Rendered whole over a real RoadmapStore on
 * jsdom's localStorage, with synthetic records only.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, render, waitFor, fireEvent, within, type RenderResult } from '@testing-library/react';
import type { Suggestion } from '@roadmap/health-core';
import {
  addMeasurement,
  bulkSaveDocuments,
  bulkSaveLabValues,
  flushRoadmapStore,
  saveMedication,
  saveScreening,
  saveSupplement,
} from '../lib/roadmap-data';
import { seedGuest, useHealthToolLifecycle } from '../testing/health-tool-harness';
import { openSettings } from '../testing/settings';

vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/server-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/server-api')>()),
  trackProductEvent: vi.fn(),
  trackABImpression: vi.fn(),
  trackABConversion: vi.fn(),
}));
vi.mock('../lib/chat-api', () => ({ listConversations: () => Promise.resolve(null), getChatGate: () => null }));
vi.mock('./ChatEmbed', () => ({ ChatEmbed: () => null }));
vi.mock('./ChatSection', () => ({ ChatSection: () => null }));
vi.mock('./UploadModal', () => ({ UploadModal: () => null }));
// The plan's suggestions, as usePlanView is handed them: what the page must draw.
const planSeen = vi.hoisted(() => ({ suggestions: [] as Suggestion[] }));
vi.mock('./ResultsPanel', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ResultsPanel')>();
  return { ...real, usePlanView: (o: Parameters<typeof real.usePlanView>[0]) => { planSeen.suggestions = o.results?.suggestions ?? []; return real.usePlanView(o); } };
});

import { HealthTool } from './HealthTool';

useHealthToolLifecycle();

const DAY = '2026-10-12';
const EARLIER = '2026-04-10';

/** Synthetic records, each a different reach of the plan: urgent results, both medicine
 *  cascades, every screening group a sex and age opens, a minor, no birth date, a lab eGFR. */
const RECORDS: Record<string, () => Promise<void>> = {
  'urgent results, both cascades, a supplement': async () => {
    await seedGuest({ sex: 'male', heightCm: 178, birthYear: 1968, birthMonth: 6, unitSystem: 'si' },
      [['weight', 95], ['waist', 104], ['systolic_bp', 158], ['diastolic_bp', 98], ['hba1c', 44], ['ldl', 4.1], ['creatinine', 92]], [], EARLIER);
    for (const [metric, value] of [['weight', 92], ['waist', 101], ['systolic_bp', 162], ['diastolic_bp', 101], ['hba1c', 50], ['ldl', 4.4],
      ['apob', 1.25], ['total_cholesterol', 6.6], ['hdl', 1.0], ['triglycerides', 2.3], ['lpa', 140], ['creatinine', 98]] as const) {
      await addMeasurement(metric, value, DAY);
    }
    await saveMedication('statin', 'atorvastatin', 20);
    await saveSupplement('magnesium', 'Magnesium', 300, 'mg');
    await saveScreening('colorectal_method', 'fit_annual');
    await saveScreening('prostate_discussion', 'not_yet');
  },
  'a woman of 52 with her screenings answered': async () => {
    await seedGuest({ sex: 'female', heightCm: 165, birthYear: 1974, birthMonth: 3, unitSystem: 'si' }, [['weight', 70], ['ldl', 2.8]], [], DAY);
    await saveScreening('breast_frequency', 'biennial');
    await saveScreening('cervical_method', 'hpv_every_5yr');
    await saveScreening('colorectal_method', 'not_yet_started');
    await saveScreening('endometrial_abnormal_bleeding', 'yes_need_to_report');
  },
  'a man of 66 who will screen, PSA 6.5, a former smoker': async () => {
    await seedGuest({ sex: 'male', heightCm: 180, birthYear: 1960, birthMonth: 1, unitSystem: 'si' }, [['weight', 85], ['psa', 6.5]], [], DAY);
    await saveScreening('prostate_discussion', 'will_screen');
    await saveScreening('lung_smoking_history', 'former_smoker');
    await saveScreening('lung_pack_years', '30');
  },
  'a known minor': async () => {
    await seedGuest({ sex: 'female', heightCm: 150, birthYear: new Date().getFullYear() - 12, birthMonth: 1, unitSystem: 'si' }, [['weight', 45], ['ldl', 4.9]], [], DAY);
  },
  'no birth date, a blood test': async () => {
    await seedGuest({ sex: 'male', heightCm: 175, unitSystem: 'si' }, [['weight', 115], ['waist', 115], ['ldl', 4.9]], [], DAY);
  },
  'a low lab eGFR': async () => {
    await seedGuest({ sex: 'female', heightCm: 165, birthYear: 1950, birthMonth: 1, unitSystem: 'si' }, [['weight', 70], ['creatinine', 140]], [], DAY);
    await bulkSaveLabValues([{ metricName: 'eGFR', value: 38, unit: 'mL/min/1.73m²', recordedAt: `${DAY}T00:00:00.000Z` }]);
  },
};

async function show(record: () => Promise<void>): Promise<RenderResult> {
  await record();
  await flushRoadmapStore();
  const view = render(<HealthTool />);
  await waitFor(() => expect(view.container.querySelector('.mh-sections')).not.toBeNull());
  await waitFor(() => expect(planSeen.suggestions.length).toBeGreaterThan(0));
  return view;
}

const topics = (view: RenderResult) => [...view.container.querySelectorAll<HTMLElement>('.mh-topic')].map(t => t.dataset.topic);
/** The plan's suggestion with this title; the page names none by id (US-09 AC7d). */
function titled(title: string) {
  const found = planSeen.suggestions.filter(s => s.title === title);
  expect(found, title).toHaveLength(1);
  return found[0];
}
/** The suggestions a card draws, by their titles. */
const cardSuggestions = (card: Element) => [...card.querySelectorAll('.suggestion-title')].map(t => titled(t.textContent!));
/** The suggestion a row draws, by its info button's name. */
const rowSuggestion = (row: Element) => titled(row.querySelector('.mh-info-btn')!.getAttribute('aria-label')!.replace(/^About: /, ''));
/** Each suggestion id drawn as a card, and on a row. */
function drawn(view: RenderResult) {
  const cards = [...view.container.querySelectorAll('.mh-sections .mh-card')].flatMap(c => cardSuggestions(c).map(s => s.id));
  const rows = [...view.container.querySelectorAll('.mh-sections .mh-row-suggestion')].map(r => rowSuggestion(r).id);
  return { cards, rows };
}
const count = (list: string[], id: string) => list.filter(x => x === id).length;
const rowNamed = (view: RenderResult, scope: string, label: string) =>
  [...view.container.querySelectorAll(`${scope} .md-row`)].find(r => r.querySelector('.md-row-label')?.textContent === label) as HTMLElement | undefined;

describe('US-62 AC17: the sections, in the iPhone\'s order', () => {
  it('Weight & diabetes, Sleep, Fitness, Blood pressure, Cholesterol, Cancer screening, Skin, Blood tests, Supplements, Other; an empty one hidden, Blood tests never', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const ORDER = ['weight', 'sleep', 'fitness', 'bloodPressure', 'cholesterol', 'screening', 'skin', 'bloodTests', 'supplements', 'other'];
    const shown = topics(view);
    expect(shown).toEqual(ORDER.filter(t => shown.includes(t)));
    expect(shown).toEqual(expect.arrayContaining(['weight', 'bloodPressure', 'cholesterol', 'screening', 'bloodTests', 'supplements']));
    expect(shown).not.toContain('other'); // nothing unknown in this plan
    for (const t of shown) {
      const section = view.container.querySelector(`[data-topic="${t}"]`)!;
      expect(section.querySelector('.md-row, .suggestion-card, .health-field, .supplement-add'), t).not.toBeNull();
    }
    expect(view.container.querySelector('h2.mh-title')?.textContent).toBe('My health');
  });
});

describe('US-62 AC18: every suggestion drawn exactly once', () => {
  it.each(Object.keys(RECORDS))('%s', async (name) => {
    const view = await show(RECORDS[name]);
    const { cards, rows } = drawn(view);
    expect(planSeen.suggestions.length).toBeGreaterThan(0);
    for (const s of planSeen.suggestions) {
      if (s.priority === 'urgent') {
        // An urgent one: a card at the top of its section, and on its row when it has one.
        expect(count(cards, s.id), s.id).toBe(1);
        expect(count(rows, s.id), s.id).toBeLessThanOrEqual(1);
      } else {
        expect(count(cards, s.id) + count(rows, s.id), s.id).toBe(1);
      }
    }
    // Nothing drawn that the plan does not hold.
    const ids = new Set(planSeen.suggestions.map(s => s.id));
    for (const id of [...cards, ...rows]) expect(ids.has(id), id).toBe(true);
  });

  it('within a section: urgent, then attention, then info; the urgent card first', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const rank = { urgent: 0, attention: 1, info: 2 } as const;
    for (const section of view.container.querySelectorAll('.mh-topic')) {
      const levels = [...section.querySelectorAll(':scope > .mh-card')]
        .map(c => Math.min(...cardSuggestions(c).map(s => rank[s.priority])));
      expect(levels, (section as HTMLElement).dataset.topic).toEqual([...levels].sort((a, b) => a - b));
    }
  });

  it('US-62 AC20: a medicine suggestion sits on its question, its title one line, its text behind the info button', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const placed = view.container.querySelector<HTMLElement>('.medication-cascade .mh-row-suggestion');
    expect(placed).not.toBeNull();
    const s = rowSuggestion(placed!);
    expect(s.category).toBe('medication');
    expect(placed!.querySelector('.mh-row-suggestion-text')!.textContent).toBe(s.title);
    expect(placed!.querySelector('.suggestion-desc')).toBeNull();
    const info = within(placed!).getByRole('button', { name: `About: ${s.title}` });
    expect(info.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(info);
    expect(placed!.querySelector('.suggestion-desc')!.textContent).toBe(s.description);
  });

  it('US-62 AC20: a screening suggestion shows its text under its test; prostate\'s note shows once', async () => {
    const view = await show(RECORDS['a man of 66 who will screen, PSA 6.5, a former smoker']);
    const prostate = [...view.container.querySelectorAll('.screening-group')].find(g => g.querySelector('h4')?.textContent === 'Prostate')!;
    const lines = [...prostate.querySelectorAll<HTMLElement>('.mh-row-suggestion')];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const s = rowSuggestion(line);
      expect(line.querySelector('.mh-row-suggestion-text')!.textContent).toBe(s.description);
    }
    const note = prostate.querySelectorAll('.screening-age-message');
    const said = lines.some(l => [...note].some(n => l.textContent!.includes(n.textContent!.trim())));
    expect(said).toBe(false); // a note a suggestion already says is not shown again
  });
});

describe('US-62 AC19: the urgent banner', () => {
  it('names the first urgent card and, pressed, scrolls to it and moves the focus there', async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const banner = view.getByRole('button', { name: /^Needs attention: / });
    const firstUrgent = view.container.querySelector<HTMLElement>('.mh-sections .mh-card .suggestion-urgent')!.closest<HTMLElement>('.mh-card')!;
    expect(banner.textContent).toContain(firstUrgent.querySelector('.suggestion-title')!.textContent);
    fireEvent.click(banner);
    expect(scrolled).toContain(firstUrgent);
    expect(document.activeElement).toBe(firstUrgent);
  });

  it('shows no banner without an urgent suggestion', async () => {
    const view = await show(RECORDS['a known minor']);
    expect(planSeen.suggestions.some(s => s.priority === 'urgent')).toBe(false); // the premise
    expect(view.container.querySelector('.mh-banner')).toBeNull();
  });
});

describe('US-62 AC17: the jump pills', () => {
  it('three pills, Blood tests, Cholesterol, Supplements, each scrolling to its heading', async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const pills = [...view.container.querySelectorAll<HTMLButtonElement>('.mh-pills .mh-pill')];
    expect(pills.map(p => p.textContent)).toEqual(['Blood tests', 'Cholesterol', 'Supplements']);
    for (const [pill, topic] of [[pills[0], 'bloodTests'], [pills[1], 'cholesterol'], [pills[2], 'supplements']] as const) {
      fireEvent.click(pill);
      const heading = view.container.querySelector(`#mh-topic-${topic}`)!;
      expect(scrolled.at(-1)).toBe(heading);
      expect(document.activeElement).toBe(heading);
    }
  });
});

describe('US-62 AC21: the rows', () => {
  it('waist-to-height leads Weight & diabetes with "Normal <0.5", the series\' value and the one before; weight shows the BMI; HbA1c in both topics', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const weightRows = [...view.container.querySelectorAll('[data-topic="weight"] .md-row-label')].map(l => l.textContent);
    expect(weightRows).toEqual(['Waist-to-height', 'Weight', 'HbA1c']);
    const whtr = rowNamed(view, '[data-topic="weight"]', 'Waist-to-height')!;
    expect(whtr.querySelector('.md-row-meta')!.textContent).toBe('Normal <0.5 · Oct 2026');
    expect(whtr.querySelector('.md-row-value')!.textContent).toBe(`${(101 / 178).toFixed(2)} (${(104 / 178).toFixed(2)})`);
    expect(rowNamed(view, '[data-topic="weight"]', 'Weight')!.querySelector('.md-row-meta')!.textContent).toBe(`BMI ${Math.round(92 / 1.78 ** 2 * 10) / 10} · Oct 2026`);
    expect(rowNamed(view, '[data-topic="bloodTests"]', 'HbA1c')).toBeDefined();
    // The ratio's row opens the waist's page.
    fireEvent.click(whtr);
    expect(within(view.container.querySelector<HTMLElement>('.md-page')!).getByRole('heading', { name: 'Waist' })).toBeTruthy();
  });

  it('one eGFR row under creatinine, in Blood pressure and Blood tests: the plan\'s value, "Calculated", the day before in brackets', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    for (const scope of ['[data-topic="bloodPressure"]', '[data-topic="bloodTests"]']) {
      const labels = [...view.container.querySelectorAll(`${scope} .md-row-label`)].map(l => l.textContent);
      expect(labels.filter(l => l === 'eGFR'), scope).toHaveLength(1);
      expect(labels.indexOf('eGFR'), scope).toBe(labels.indexOf('Creatinine') + 1);
      const egfr = rowNamed(view, scope, 'eGFR')!;
      expect(egfr.querySelector('.md-row-meta')!.textContent).toMatch(/Calculated · Oct 2026$/);
      expect(egfr.querySelector('.md-row-prev')).not.toBeNull();
    }
  });

  it('a lab eGFR the plan uses: the one row says "Lab result" and opens the lab\'s page, which links to creatinine; no second eGFR row', async () => {
    const view = await show(RECORDS['a low lab eGFR']);
    const labels = [...view.container.querySelectorAll('[data-topic="bloodTests"] .md-row-label')].map(l => l.textContent);
    expect(labels.filter(l => /eGFR/.test(l ?? ''))).toEqual(['eGFR']);
    const egfr = rowNamed(view, '[data-topic="bloodTests"]', 'eGFR')!;
    expect(egfr.querySelector('.md-row-meta')!.textContent).toMatch(/Lab result · Oct 2026$/);
    expect(egfr.querySelector('.md-row-value')!.textContent).toBe('38');
    fireEvent.click(egfr);
    const page = view.container.querySelector<HTMLElement>('.md-page')!;
    expect(within(page).getByRole('button', { name: 'Creatinine' })).toBeTruthy();
    expect(within(page).getByText('eGFR', { selector: '.stat-label' })).toBeTruthy(); // the tile's explainer on its page (AC26)
  });

  it('Cholesterol leads with ApoB, LDL, total, HDL, then non-HDL when the plan works it out, triglycerides and Lp(a)', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const labels = [...view.container.querySelectorAll('[data-topic="cholesterol"] .md-row-label')].map(l => l.textContent);
    expect(labels).toEqual(['ApoB', 'LDL Cholesterol', 'Total Cholesterol', 'HDL Cholesterol', 'Triglycerides', 'Lp(a)'].flatMap(l => (l === 'Triglycerides' ? labels.includes('Non-HDL Cholesterol') ? ['Non-HDL Cholesterol', l] : [l] : [l])));
  });
});

describe('US-62 AC22, AC23: Blood tests and Supplements', () => {
  it('"+" uploads on the Blood tests heading; "Add blood test" and "All results as a table" end its rows', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const section = view.container.querySelector<HTMLElement>('[data-topic="bloodTests"]')!;
    expect(within(section.querySelector<HTMLElement>('.mh-topic-head')!).getByRole('button', { name: 'Upload lab results' })).toBeTruthy();
    const add = within(section).getByRole('button', { name: '+ Add a blood test' });
    const table = within(section).getByRole('button', { name: 'All results as a table' });
    expect(add.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(add);
    expect(within(section).getByLabelText('Test')).toBeTruthy(); // the existing add (US-21)
  });

  it('Supplements: the cards, then my list ending in "Add another supplement"; no quick-add chips', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const section = view.container.querySelector<HTMLElement>('[data-topic="supplements"]')!;
    const card = section.querySelector('.mh-card');
    const mine = section.querySelector('.supplement-row');
    expect(card && mine && card.compareDocumentPosition(mine) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(view.container.querySelector('.supplement-chip')).toBeNull();
  });

  it('AC30c: "+ Add another supplement" is the same row as "+ Add a blood test", opening its search focused', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const supplements = view.container.querySelector<HTMLElement>('[data-topic="supplements"]')!;
    const bloodTests = view.container.querySelector<HTMLElement>('[data-topic="bloodTests"]')!;
    const add = within(supplements).getByRole('button', { name: '+ Add another supplement' });
    const test = within(bloodTests).getByRole('button', { name: '+ Add a blood test' });
    expect(add.className).toBe(test.className);
    expect(add.parentElement!.classList.contains('mh-add-test')).toBe(true);
    expect(test.parentElement!.classList.contains('mh-add-test')).toBe(true);
    fireEvent.click(add);
    // Focused inside the tap itself (US-01 AC6), so a phone opens its keyboard.
    expect(document.activeElement).toBe(within(supplements).getByPlaceholderText('Add another supplement...'));
  });

  it('AC30c: the search goes back to its row when left empty, on Escape, and once a supplement is added', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const supplements = view.container.querySelector<HTMLElement>('[data-topic="supplements"]')!;
    const row = () => within(supplements).queryByRole('button', { name: '+ Add another supplement' });
    const search = () => within(supplements).queryByPlaceholderText('Add another supplement...') as HTMLInputElement | null;
    // Left empty: Tab or a tap elsewhere takes the focus out of the box.
    fireEvent.click(row()!);
    fireEvent.blur(search()!, { relatedTarget: document.body });
    expect(search()).toBeNull();
    expect(row()).not.toBeNull();
    // Something typed stays open when left.
    fireEvent.click(row()!);
    fireEvent.change(search()!, { target: { value: 'Tau' } });
    fireEvent.blur(search()!, { relatedTarget: document.body });
    expect(search()!.value).toBe('Tau');
    // Escape: back to the row, the focus on it.
    fireEvent.keyDown(search()!, { key: 'Escape' });
    expect(search()).toBeNull();
    expect(document.activeElement).toBe(row());
    // A supplement added: back to the row, the supplement listed.
    fireEvent.click(row()!);
    fireEvent.change(search()!, { target: { value: 'Taurine test' } });
    fireEvent.click(supplements.querySelector('.supplement-custom')!);
    expect(search()).toBeNull();
    expect(row()).not.toBeNull();
    expect([...supplements.querySelectorAll('.supplement-name')].map(n => n.textContent)).toContain('Taurine test');
  });

  it('AC30c (#985): Tab from the empty search through its list and out past the last option: back to the row', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const supplements = view.container.querySelector<HTMLElement>('[data-topic="supplements"]')!;
    const row = () => within(supplements).queryByRole('button', { name: '+ Add another supplement' });
    const search = () => within(supplements).queryByPlaceholderText('Add another supplement...') as HTMLInputElement | null;
    const options = () => [...supplements.querySelectorAll<HTMLButtonElement>('.supplement-dropdown-item')];
    fireEvent.click(row()!);
    // Empty, the list shows every option. Tab into it, then down it: the search stays open.
    expect(options().length).toBeGreaterThan(1);
    const first = options()[0];
    fireEvent.blur(search()!, { relatedTarget: first });
    first.focus();
    const last = options().at(-1)!;
    fireEvent.blur(first, { relatedTarget: last });
    last.focus();
    expect(search()).not.toBeNull();
    expect(options().length).toBeGreaterThan(1);
    // Tab out past the last option: the row is back, no empty search left open.
    fireEvent.blur(last, { relatedTarget: document.body });
    expect(search()).toBeNull();
    expect(row()).not.toBeNull();
  });
});

describe('US-62 AC24: a guest\'s storage card, at the foot and in Settings', () => {
  it('shows at the foot of My health for a record on this device; in Settings when they open, one at a time', async () => {
    await RECORDS['a known minor']();
    await flushRoadmapStore();
    const storage = ({ hasData }: { hasData: boolean }) => <div className="hr-sync">Where do you want to keep your health record? {String(hasData)}</div>;
    const view = render(<HealthTool syncControl={storage}/>);
    await waitFor(() => expect(view.container.querySelector('.mh-sections')).not.toBeNull());
    const cards = () => [...view.container.querySelectorAll('.hr-sync')];
    expect(cards()).toHaveLength(1);
    expect(cards()[0].closest('.mh-foot-storage')).not.toBeNull();
    expect(view.container.querySelector('.mh-sections')!.compareDocumentPosition(cards()[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    openSettings(view.container);
    expect(cards()).toHaveLength(1); // one picker on the page
    expect(cards()[0].closest('.mh-settings')).not.toBeNull();
  });
});

describe('US-62 AC24: Settings behind the person button', () => {
  it('holds About you, units, the record and Delete all my data; Done closes them and the focus returns to the button', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const person = view.getByRole('button', { name: 'Settings' });
    expect(view.container.querySelector('.about-card')).toBeNull(); // not on the page
    fireEvent.click(person);
    const sheet = view.container.querySelector<HTMLElement>('.mh-settings')!;
    expect(within(sheet).getByRole('heading', { name: 'Settings' })).toBe(document.activeElement);
    expect(within(sheet).getByRole('heading', { name: /About you/ })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: /Switch units/ })).toBeTruthy();
    expect(within(sheet).getByRole('button', { name: 'Delete all my data' })).toBeTruthy();
    expect(view.container.querySelector('.health-input-panel')!.className).toContain('md-page-open');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(view.container.querySelector('.mh-settings')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(view.getByRole('button', { name: 'Settings' })));
  });

  it('Escape inside them closes them; Escape elsewhere, or with another dialog open, does not', async () => {
    const view = await show(RECORDS['a known minor']);
    openSettings(view.container);
    const sheet = view.container.querySelector<HTMLElement>('.mh-settings')!;
    fireEvent.keyDown(document.body, { key: 'Escape' }); // focus outside the sheet
    expect(view.container.querySelector('.mh-settings')).not.toBeNull();
    const dialog = document.body.appendChild(document.createElement('dialog'));
    dialog.setAttribute('open', '');
    fireEvent.keyDown(within(sheet).getByRole('button', { name: 'Done' }), { key: 'Escape' });
    expect(view.container.querySelector('.mh-settings')).not.toBeNull();
    dialog.remove();
    // A dialog drawn as a div (the alcohol question's) counts too: its Escape is its own.
    const popup = document.body.appendChild(document.createElement('div'));
    popup.setAttribute('role', 'dialog');
    popup.setAttribute('aria-modal', 'true');
    fireEvent.keyDown(within(sheet).getByRole('button', { name: 'Done' }), { key: 'Escape' });
    expect(view.container.querySelector('.mh-settings')).not.toBeNull();
    popup.remove();
    fireEvent.keyDown(within(sheet).getByRole('button', { name: 'Done' }), { key: 'Escape' });
    expect(view.container.querySelector('.mh-settings')).toBeNull();
  });
});

describe('US-62 AC10: typed, unsaved Add input is never dropped silently', () => {
  const valueInput = (view: RenderResult) => within(view.container.querySelector<HTMLElement>('.md-page:not(.mh-settings)')!).getByLabelText(/Value/) as HTMLInputElement;

  it('Settings opened over a value page keep its typing; Done brings it back', async () => {
    const view = await show(RECORDS['a low lab eGFR']);
    fireEvent.click(rowNamed(view, '[data-topic="bloodTests"]', 'Creatinine')!);
    fireEvent.change(valueInput(view), { target: { value: '101' } });
    openSettings(view.container);
    const sheet = view.container.querySelector<HTMLElement>('.mh-settings')!;
    // The value page is out of sight behind Settings, not gone.
    expect(view.container.querySelector('.md-page:not(.mh-settings)')!.closest('[hidden]')).not.toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(valueInput(view).value).toBe('101');
    expect(view.container.querySelector('.md-page:not(.mh-settings)')!.closest('[hidden]')).toBeNull();
  });

  it('Back with Settings over a value page closes Settings; the page shows with its typing, nothing asked', async () => {
    const view = await show(RECORDS['a low lab eGFR']);
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    fireEvent.click(rowNamed(view, '[data-topic="bloodTests"]', 'Creatinine')!);
    fireEvent.change(valueInput(view), { target: { value: '101' } });
    openSettings(view.container);
    act(() => { history.back(); });
    await waitFor(() => expect(view.container.querySelector('.mh-settings')).toBeNull());
    expect(confirm).not.toHaveBeenCalled();
    expect(valueInput(view).value).toBe('101');
    expect(view.container.querySelector('.md-page:not(.mh-settings)')!.closest('[hidden]')).toBeNull();
    await waitFor(() => expect(history.state?.hrValuePage).toBe(true)); // the page keeps its entry
    await waitFor(() => expect(document.activeElement).toBe(view.getByRole('button', { name: 'Settings' })));
  });

  it('the creatinine page\'s link to the lab eGFR asks first; declined, the page and its typing stay', async () => {
    const view = await show(RECORDS['a low lab eGFR']);
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);
    fireEvent.click(rowNamed(view, '[data-topic="bloodTests"]', 'Creatinine')!);
    fireEvent.change(valueInput(view), { target: { value: '101' } });
    fireEvent.click(view.getByRole('button', { name: 'Lab eGFR results' }));
    expect(confirm).toHaveBeenCalledWith('Leave without saving the value you typed?');
    expect(view.container.querySelector('.md-page-title')!.textContent).toBe('Creatinine');
    expect(valueInput(view).value).toBe('101');
    confirm.mockReturnValue(true);
    fireEvent.click(view.getByRole('button', { name: 'Lab eGFR results' }));
    expect(view.container.querySelector('.md-page-title')!.textContent).not.toBe('Creatinine');
  });
});

describe('US-62 AC25, AC26: the onboarding first, the foot last', () => {
  it('until the onboarding is done, the form and the plan\'s tiles show, and no topic', async () => {
    await seedGuest({ heightCm: 172, unitSystem: 'si' }, [['weight', 80]], [], DAY);
    const view = render(<HealthTool />);
    await waitFor(() => expect(view.container.querySelector('.quick-stats .stat-card')).not.toBeNull());
    expect(view.container.querySelector('.about-card')).not.toBeNull();
    expect(view.container.querySelector('.mh-sections')).toBeNull();
    expect(view.container.querySelector('.mh-banner')).toBeNull();
  });

  it('AC30d: the PDF box sits above the pills, out of the foot', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const pdf = view.container.querySelector('.mh-topics > .mh-pdf')!;
    expect(pdf.textContent).toMatch(/PDF/);
    expect(pdf.nextElementSibling!.classList.contains('mh-pills')).toBe(true);
    expect(view.container.querySelector('.mh-foot .mh-pdf, .mh-foot .email-capture, .mh-foot .report-actions')).toBeNull();
  });

  it('the foot: the disclaimer, Supercharge and the privacy link, after the topics', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const foot = view.container.querySelector('.mh-foot')!;
    expect(view.container.querySelector('.mh-sections')!.compareDocumentPosition(foot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(foot.querySelector('.health-disclaimer')).not.toBeNull();
    expect(foot.textContent).toContain('Supercharge this tool');
    expect(foot.querySelector('.privacy-notice-link')).not.toBeNull();
  });
});

describe('US-62 AC28: Save as PDF prints the plan as it always has', () => {
  it('getReportHtml: the title, the tiles, the suggestions with a reason opened on screen and its references, the disclaimer, the privacy link; no controls', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const written: string[] = [];
    vi.spyOn(window, 'open').mockImplementation(() => ({ document: { write: (h: string) => written.push(h), close() {} }, print() {} }) as unknown as Window);
    // A reason opened on a card, and one on a row.
    const card = [...view.container.querySelectorAll('.mh-card')].find(c => c.querySelector('.evidence-toggle'))!;
    const cardSuggestion = cardSuggestions(card)[0];
    fireEvent.click(card.querySelector('.evidence-toggle')!);
    expect(card.querySelector('.evidence-reason')!.textContent).toBe(cardSuggestion.reason);
    const line = view.container.querySelector('.medication-cascade .mh-row-suggestion')!;
    const rowSuggestionShown = rowSuggestion(line);
    fireEvent.click(line.querySelector('.mh-info-btn')!);
    fireEvent.click(line.querySelector('.evidence-toggle')!);
    expect(line.querySelector('.evidence-reason')!.textContent).toBe(rowSuggestionShown.reason);
    fireEvent.click(view.getByRole('button', { name: 'Save as PDF' }));
    await waitFor(() => expect(written).toHaveLength(1));
    const doc = new DOMParser().parseFromString(written[0], 'text/html');
    expect(doc.querySelector('.hr-col-title')!.textContent).toBe('Your plan to discuss with your doctor');
    expect(doc.querySelectorAll('.stat-card').length).toBeGreaterThan(0);
    const titles = [...doc.querySelectorAll('.suggestion-title')].map(t => t.textContent);
    expect(titles.sort()).toEqual(planSeen.suggestions.map(s => s.title).sort());
    const printed = [...doc.querySelectorAll('.suggestion-card, .suggestion-subsection')]
      .find(c => c.querySelector('.suggestion-title')!.textContent === cardSuggestion.title)!;
    expect(printed.querySelector('.evidence-reason')!.textContent).toBe(cardSuggestion.reason);
    expect([...printed.querySelectorAll('.evidence-refs a')].map(a => a.getAttribute('href'))).toEqual(cardSuggestion.references!.map(r => r.url));
    // A row's reason opened on screen prints open on its card; no other does.
    const rowPrinted = [...doc.querySelectorAll('.suggestion-card, .suggestion-subsection')]
      .find(c => c.querySelector('.suggestion-title')!.textContent === rowSuggestionShown.title)!;
    expect(rowPrinted.querySelector('.evidence-reason')!.textContent).toBe(rowSuggestionShown.reason);
    expect(doc.querySelectorAll('.evidence-reason')).toHaveLength(2);
    expect(doc.querySelector('.health-disclaimer')!.textContent).toMatch(/^Disclaimer: This tool is for educational purposes only/);
    expect(doc.querySelector('.privacy-notice-link a')!.getAttribute('href')).toBe('https://drstanfield.com/pages/connector-privacy');
    expect(doc.querySelectorAll('button, input, select, textarea, .hr-guide-card, .feedback-form, .reminders-section')).toHaveLength(0);
  });
});

describe('US-62 live fixes (2026-11-06): jumps clear the theme\'s sticky header; Back finds its row', () => {
  /** A theme header fixed over the viewport's top, 60px tall, as drstanfield.com's. */
  function themeHeader(height: number) {
    const bar = document.body.appendChild(document.createElement('header'));
    bar.style.position = 'fixed';
    vi.spyOn(bar, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: height, height } as DOMRect);
    Object.defineProperty(document, 'elementsFromPoint', { configurable: true, value: () => [bar] });
    return () => { bar.remove(); delete (document as { elementsFromPoint?: unknown }).elementsFromPoint; };
  }

  it('a pill, the banner and a value page land 12px under a 60px theme header; with none, 12px under the top', async () => {
    const scrolled: Element[] = [];
    const how: Array<ScrollIntoViewOptions | undefined> = [];
    Element.prototype.scrollIntoView = function (this: Element, o?: boolean | ScrollIntoViewOptions) { scrolled.push(this); how.push(o as ScrollIntoViewOptions); };
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const off = themeHeader(60);
    fireEvent.click(view.getByRole('button', { name: 'Cholesterol' }));
    const heading = view.container.querySelector<HTMLElement>('#mh-topic-cholesterol')!;
    expect(scrolled.at(-1)).toBe(heading);
    expect(heading.style.scrollMarginTop).toBe('72px');
    fireEvent.click(view.container.querySelector('.mh-banner')!);
    expect((scrolled.at(-1) as HTMLElement).style.scrollMarginTop).toBe('72px');
    fireEvent.click(rowNamed(view, '[data-topic="weight"]', 'Weight')!);
    // The page's own top (its Back link) lands 12px under the header (design re-check 2026-11-06).
    const valuePage = view.container.querySelector<HTMLElement>('.md-page:not(.mh-settings)')!;
    expect(scrolled.at(-1)).toBe(valuePage);
    expect(valuePage.style.scrollMarginTop).toBe('72px');
    // At once: the live theme's scroll-behavior: smooth slid it for up to a second (CI verify-live, PR 949).
    expect(how.at(-1)).toEqual({ behavior: 'instant', block: 'start' });
    off();
    fireEvent.click(view.getByRole('button', { name: '‹ Back' }));
    fireEvent.click(view.getByRole('button', { name: 'Supplements' }));
    expect(view.container.querySelector<HTMLElement>('#mh-topic-supplements')!.style.scrollMarginTop).toBe('12px');
  });

  it('Back from a value page focuses the row pressed and brings it into view, though the tap never focused it (WebKit)', async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    view.getByRole('button', { name: 'Settings' }).focus(); // focus elsewhere, as WebKit leaves it on a tap
    const weight = rowNamed(view, '[data-topic="weight"]', 'Weight')!;
    fireEvent.click(weight);
    fireEvent.click(view.getByRole('button', { name: '‹ Back' }));
    await waitFor(() => expect(document.activeElement).toBe(weight));
    expect(scrolled.at(-1)).toBe(weight);
  });
});

describe('US-62 AC10 (design review 2026-11-06): the value page leads with its latest value', () => {
  it('the weight page: "‹ Back", the latest value large with its unit, the target said once, every history value with its unit', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    fireEvent.click(rowNamed(view, '[data-topic="weight"]', 'Weight')!);
    const page = view.container.querySelector<HTMLElement>('.md-page')!;
    expect(within(page).getByRole('button', { name: '‹ Back' })).toBeTruthy();
    expect(page.querySelector('.md-page-latest-value')!.textContent).toBe('92.0');
    expect(page.querySelector('.md-page-latest-unit')!.textContent).toBe('kg');
    // The ideal weight tile says the target: no "Target:" line beside it.
    expect(within(page).getByText('Ideal Body Weight', { selector: '.stat-label' })).toBeTruthy();
    expect(page.querySelector('.md-page-target')).toBeNull();
    const units = [...page.querySelectorAll('.md-history-row')].map(r => r.querySelector('.alr-cell-unit')?.textContent);
    expect(units).toEqual(['kg', 'kg']);
    expect(page.querySelector('.md-page-hint')!.textContent).toBe('Tap a value to correct it.');
  });

  it('a page without a tile for its target keeps the target line; with a mouse the hint says Click', async () => {
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('min-width') || q.includes('pointer: fine'), media: q, addEventListener() {}, removeEventListener() {} }));
    fireEvent.click(rowNamed(view, '[data-topic="bloodTests"]', 'Creatinine')!);
    const page = view.container.querySelector<HTMLElement>('.md-page')!;
    expect(page.querySelector('.md-page-target')!.textContent).toMatch(/^Normal: /);
    expect(page.querySelector('.md-page-latest-unit')!.textContent).toBe('µmol/L');
    expect(page.querySelector('.md-page-hint')!.textContent).toBe('Click a value to correct it.');
  });
});

describe('US-62 AC27: the desktop section list', () => {
  it('lists the sections the page holds, in order, as links in a nav landmark; one is current; a red dot marks an urgent one', async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    const view = await show(RECORDS['urgent results, both cascades, a supplement']);
    const nav = view.getByRole('navigation', { name: 'My health sections' });
    const links = within(nav).getAllByRole('link');
    expect(links.map(l => l.querySelector('.mh-nav-title')!.textContent)).toEqual(
      [...view.container.querySelectorAll('.mh-topic .mh-topic-head h3')].map(h => h.textContent));
    expect(links.filter(l => l.getAttribute('aria-current') === 'location')).toHaveLength(1);
    // The dot sits on each section holding an urgent card, and on no other.
    const urgentTopics = [...view.container.querySelectorAll<HTMLElement>('.mh-topic')]
      .filter(t => t.querySelector(':scope > .mh-card .suggestion-urgent')).map(t => t.querySelector('h3')!.textContent);
    expect(urgentTopics.length).toBeGreaterThan(0);
    expect(links.filter(l => l.querySelector('.mh-nav-dot')).map(l => l.querySelector('.mh-nav-title')!.textContent)).toEqual(urgentTopics);
    expect(links.find(l => l.querySelector('.mh-nav-dot'))!.textContent).toContain(', needs attention'); // said, not only drawn
    // A press goes to its section and marks it current.
    const cholesterol = links.find(l => l.textContent?.startsWith('Cholesterol'))!;
    expect(cholesterol.getAttribute('href')).toBe('#mh-topic-cholesterol');
    fireEvent.click(cholesterol);
    expect(scrolled.at(-1)).toBe(view.container.querySelector('#mh-topic-cholesterol'));
    expect(cholesterol.getAttribute('aria-current')).toBe('location');
  });

  // US-62 AC33 (Brad 2026-11-09): Documents in the desktop list, only when the area shows; never on a phone.
  const withLetter = async () => {
    await RECORDS['urgent results, both cascades, a supplement']();
    await bulkSaveDocuments([{ documentType: 'clinic_letter', title: 'Clinic letter', documentDate: '2026-09-01', contentMd: 'A letter.', metadata: {}, sourceFileName: 'letter.pdf' }]);
  };
  const navTitles = (view: RenderResult) => [...view.container.querySelectorAll('.mh-nav .mh-nav-title')].map(t => t.textContent);

  it('AC33: with a letter on record, "Documents" ends the list and jumps to the documents area', async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    const view = await show(withLetter);
    const area = await waitFor(() => { const h = view.container.querySelector<HTMLElement>('#mh-topic-documents'); expect(h).not.toBeNull(); return h!; });
    expect(area.textContent).toBe('Documents');
    expect(navTitles(view).at(-1)).toBe('Documents');
    const link = within(view.getByRole('navigation', { name: 'My health sections' })).getByRole('link', { name: 'Documents' });
    expect(link.getAttribute('href')).toBe('#mh-topic-documents');
    fireEvent.click(link);
    expect(scrolled.at(-1)).toBe(area);
    expect(document.activeElement).toBe(area);
    // The pills stay the three (no room on a phone).
    expect([...view.container.querySelectorAll('.mh-pill')].map(p => p.textContent)).toEqual(['Blood tests', 'Cholesterol', 'Supplements']);
  });

  it('AC33: with no documents (a blood-test report alone is not one), no entry and no area', async () => {
    const view = await show(async () => {
      await RECORDS['urgent results, both cascades, a supplement']();
      await bulkSaveDocuments([{ documentType: 'pathology_report', title: 'Labs', documentDate: '2026-09-01', contentMd: '', metadata: { labArchive: true }, sourceFileName: 'labs.pdf' }]);
    });
    expect(navTitles(view).length).toBeGreaterThan(0);
    expect(navTitles(view)).not.toContain('Documents');
    expect(view.container.querySelector('#mh-topic-documents')).toBeNull();
  });

  it('AC33: on a phone the list is not drawn, so no Documents entry; the area still shows', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));
    const view = await show(withLetter);
    await waitFor(() => expect(view.container.querySelector('#mh-topic-documents')).not.toBeNull());
    expect(view.queryByRole('navigation', { name: 'My health sections' })).toBeNull();
    expect(view.queryByRole('link', { name: 'Documents' })).toBeNull();
  });
});
