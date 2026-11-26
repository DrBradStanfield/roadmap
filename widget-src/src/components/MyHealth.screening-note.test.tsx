// @vitest-environment jsdom
/**
 * US-62 AC41: where no screening question applies, My health's Cancer screening shows the
 * iPhone's note in the questions' place: urgent cards above it, other cards below, as the iPhone. Before the
 * form is full no topic shows, so neither does the note. On both store postures.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import type { HealthResults, Suggestion } from '@roadmap/health-core/types';
import { MyHealth, type FormSlots } from './MyHealth';
import { OpenEvidenceContext } from './PlanCards';
import { usePlanView } from './ResultsPanel';
import { setMarketCountry } from '../lib/market-country';
import type { PlanForms } from '../lib/plan-forms';

const flags = vi.hoisted(() => ({ shopify: false }));
vi.mock('../lib/build-flags', async importOriginal => ({ ...await importOriginal<typeof import('../lib/build-flags')>(), get SHOPIFY_SURFACE() { return flags.shopify; } }));
vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {} }));
afterEach(cleanup);
afterEach(() => { flags.shopify = false; setMarketCountry(null); });

const NOTE = 'No screening questions apply at your age and sex yet.';
const NOTED: PlanForms = { medications: [], screenings: [], screeningNote: NOTE };
const ASKED: PlanForms = { medications: [], screenings: [{ id: 'cancer-screening', title: '', intro: '', groups: [] }], screeningNote: null };
const CARD: Suggestion = { id: 'screening-colorectal-overdue', category: 'screening', priority: 'attention', title: 'Colorectal screening card', description: '' };
const URGENT: Suggestion = { id: 'screening-lung-followup', category: 'screening', priority: 'urgent', title: 'Lung follow-up card', description: '' };

function slots(fullForm: boolean): FormSlots {
  return {
    panelRef: createRef<HTMLDivElement>(), messages: null, aboutCard: null, aboutYouLow: true, unitPill: null,
    fullForm, planReady: true, pageOpen: false, renderPage: () => null,
    rows: { ctx: { grading: null, plan: null, unitOf: () => 'si' }, open: () => {}, vitals: [], blood: [], labs: [], withoutWeight: false },
    vitalsCue: null, bloodCue: null, tableShown: false, showTable: () => {}, table: null, addTest: null,
    weightMedications: () => null, lipidMedications: () => null,
    // As InputPanel's renderers: nothing where no screening question applies.
    screening: () => <div data-q="cancer-screening"/>, boneDensity: () => null, supplements: () => null,
  };
}

function Page({ forms, suggestions, fullForm }: { forms: PlanForms; suggestions: Suggestion[]; fullForm: boolean }) {
  const plan = usePlanView({ results: { suggestions, knownMinor: false, age: 20 } as unknown as HealthResults, shownErase: '', isValid: true, tiles: [], forms, cardsShown: fullForm });
  return (
    <OpenEvidenceContext.Provider value={plan.evidence}>
      <MyHealth form={slots(fullForm)} plan={plan} tiles={[]} series={{ whtr: [], egfr: [] }} egfrCurrent={null}
                settingsOpen={false} onSettingsClose={() => {}} onDelete={() => {}}/>
    </OpenEvidenceContext.Provider>
  );
}

/** Cancer screening's parts below its heading, top to bottom. */
function screening(forms: PlanForms, suggestions: Suggestion[], fullForm = true): string[] | null {
  const section = render(<Page forms={forms} suggestions={suggestions} fullForm={fullForm}/>).container.querySelector('section[data-topic="screening"]');
  return section && [...section.children].slice(1).map(part =>
    part.classList.contains('mh-card') ? 'card' : part.hasAttribute('data-q') ? 'questions' : `${part.className}: ${part.textContent}`);
}

describe.each([['the doctor posture', false], ['the brand posture (Shopify, US)', true]])('US-62 AC41, %s', (_, shopify) => {
  const posture = () => { flags.shopify = shopify; setMarketCountry(shopify ? 'US' : null); };

  it('no screening question and no screening card: Cancer screening with the note alone', () => {
    posture();
    expect(screening(NOTED, [])).toEqual([`mh-screening-note: ${NOTE}`]);
  });

  it('no screening question, a screening card: the note above the card, as the iPhone', () => {
    posture();
    expect(screening(NOTED, [CARD])).toEqual([`mh-screening-note: ${NOTE}`, 'card']);
  });

  it('no screening question, an urgent and another screening card: urgent card, note, other card', () => {
    posture();
    expect(screening(NOTED, [CARD, URGENT])).toEqual(['card', `mh-screening-note: ${NOTE}`, 'card']);
  });

  it('screening questions apply: the questions, no note', () => {
    posture();
    expect(screening(ASKED, [CARD])).toEqual(['questions', 'card']);
  });

  it('before the form is full: no Cancer screening and no note (decided 2026-11-26: the cards come at the onboarding\'s end)', () => {
    posture();
    const page = render(<Page forms={NOTED} suggestions={[CARD]} fullForm={false}/>).container;
    expect(page.querySelector('section.mh-topic')).toBeNull();
    expect(page.textContent).not.toContain(NOTE);
    expect(page.querySelector('.mh-card')).toBeNull();
  });
});
