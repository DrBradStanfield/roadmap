import { describe, it, expect } from 'vitest';
import { emailBox, pdfBox, storagePulse } from './PlanPdf';

// Pins pdfBox and storagePulse to what the code drew before the rules were
// named (US-62 AC26, US-44, US-07 AC6, US-09 AC19). `today*` copy the old
// inline expressions verbatim, from PlanPdf, GuestEmailCapture and usePlanView;
// the hand-written rows say what each case means.

type State = 'idle' | 'sending' | 'captured' | 'skipped' | 'reminded';
const STATES: State[] = ['idle', 'sending', 'captured', 'skipped', 'reminded'];
const BOOLS = [false, true];

interface Facts { planned: boolean; adult: boolean; emailCapture: boolean; state: State; gateSkipped: boolean; shopify: boolean }

/** PlanPdf's `ungatedPdf`, `box` and its null return, and GuestEmailCapture's branches, before the change. */
function todayBox({ planned, adult, emailCapture, state, gateSkipped, shopify }: Facts) {
  const ungatedPdf = planned && (!shopify || state === 'captured' || gateSkipped || !adult);
  const email = !emailCapture ? null : state === 'captured' ? null : gateSkipped ? 'reminders' : 'gate';
  return { email, save: ungatedPdf, shown: emailCapture || ungatedPdf };
}

interface PulseFacts { shopify: boolean; state: State; gateSkipped: boolean; knownMinor: boolean; pdfOpened: boolean }

/** usePlanView's `attention`, before the change. */
function todayPulse({ shopify, state, gateSkipped, knownMinor, pdfOpened }: PulseFacts) {
  return shopify && (state === 'captured' || state === 'reminded' || ((!!gateSkipped || !!knownMinor) && pdfOpened));
}

function* allFacts(): Generator<Facts> {
  for (const planned of BOOLS) for (const adult of BOOLS) for (const emailCapture of BOOLS)
    for (const state of STATES) for (const gateSkipped of BOOLS) for (const shopify of BOOLS)
      yield { planned, adult, emailCapture, state, gateSkipped, shopify };
}

/** What usePlanView can hand the box: emailCapture needs an adult, an adult needs a plan. */
const reachable = (f: Facts) => (!f.emailCapture || f.adult) && (!f.adult || f.planned);

const adultPlan = { planned: true, adult: true, emailCapture: true, gateSkipped: false, shopify: true };

describe('pdfBox: the PDF box mode, as before (US-62 AC26)', () => {
  const rows: Array<[string, Facts, { email: 'gate' | 'reminders' | null; save: boolean }]> = [
    ['no plan: nothing', { ...adultPlan, planned: false, adult: false, emailCapture: false, state: 'idle' }, { email: null, save: false }],
    ['no plan, record captured: nothing', { ...adultPlan, planned: false, adult: false, emailCapture: false, state: 'captured' }, { email: null, save: false }],
    ['Pages: Save as PDF always, no gate', { ...adultPlan, emailCapture: false, shopify: false, state: 'idle' }, { email: null, save: true }],
    ['Pages with the box asked for: both', { ...adultPlan, shopify: false, state: 'idle' }, { email: 'gate', save: true }],
    ['US-18: Shopify adult before capture: the gate is the PDF path', { ...adultPlan, state: 'idle' }, { email: 'gate', save: false }],
    ['US-18: while the gate sends', { ...adultPlan, state: 'sending' }, { email: 'gate', save: false }],
    ['US-18: captured: Save as PDF only', { ...adultPlan, state: 'captured' }, { email: null, save: true }],
    ['US-44: gate skipped: reminders and Save as PDF', { ...adultPlan, gateSkipped: true, state: 'skipped' }, { email: 'reminders', save: true }],
    ['US-44: gate skipped, sending', { ...adultPlan, gateSkipped: true, state: 'sending' }, { email: 'reminders', save: true }],
    ['US-44: signed up: the done line and Save as PDF', { ...adultPlan, gateSkipped: true, state: 'reminded' }, { email: 'reminders', save: true }],
    ['US-44: gate skipped, captured before: Save as PDF only', { ...adultPlan, gateSkipped: true, state: 'captured' }, { email: null, save: true }],
    ['US-07 AC6: a known minor: no email box, Save as PDF', { ...adultPlan, adult: false, emailCapture: false, state: 'idle' }, { email: null, save: true }],
    ['adult with the box not asked for: nothing', { ...adultPlan, emailCapture: false, state: 'idle' }, { email: null, save: false }],
  ];
  it.each(rows)('%s', (_name, facts, expected) => {
    expect(pdfBox(facts)).toEqual(expected);
  });

  it('matches the old expressions on every combination of the six facts', () => {
    for (const f of allFacts()) {
      const { email, save } = todayBox(f);
      expect(pdfBox(f), JSON.stringify(f)).toEqual({ email, save });
    }
  });

  it('the box shows exactly when an email box or Save as PDF does, on every reachable input', () => {
    for (const f of allFacts()) {
      if (!reachable(f)) continue;
      const mode = pdfBox(f);
      expect(mode.email !== null || mode.save, JSON.stringify(f)).toBe(todayBox(f).shown);
    }
  });

  it('GuestEmailCapture: captured shows nothing, a skipped gate shows reminders, else the gate', () => {
    for (const state of STATES) for (const gateSkipped of BOOLS) {
      const old = state === 'captured' ? null : gateSkipped ? 'reminders' : 'gate';
      expect(emailBox(state, gateSkipped), `${state} ${gateSkipped}`).toBe(old);
    }
  });
});

describe('storagePulse, as before (US-09 AC19)', () => {
  const base: PulseFacts = { shopify: true, state: 'idle', gateSkipped: false, knownMinor: false, pdfOpened: false };
  const rows: Array<[string, PulseFacts, boolean]> = [
    ['Pages never pulses, even captured', { ...base, shopify: false, state: 'captured' }, false],
    ['Pages never pulses, gate skipped with a PDF', { ...base, shopify: false, gateSkipped: true, pdfOpened: true }, false],
    ['before capture: off', base, false],
    ['while sending: off', { ...base, state: 'sending' }, false],
    ['an adult on the gated page: a PDF window alone does not count', { ...base, pdfOpened: true }, false],
    ['captured: on', { ...base, state: 'captured' }, true],
    ['US-44 reminded: on', { ...base, gateSkipped: true, state: 'reminded' }, true],
    ['US-44 gate skipped, no window yet: off', { ...base, gateSkipped: true, state: 'skipped' }, false],
    ['US-44 gate skipped, a window opened: on', { ...base, gateSkipped: true, state: 'skipped', pdfOpened: true }, true],
    ['US-07 AC6 a known minor, no window: off', { ...base, knownMinor: true }, false],
    ['US-07 AC6 a known minor, a window opened: on', { ...base, knownMinor: true, pdfOpened: true }, true],
  ];
  it.each(rows)('%s', (_name, facts, expected) => {
    expect(storagePulse(facts)).toBe(expected);
  });

  it('matches the old expression on every combination of the five facts', () => {
    for (const shopify of BOOLS) for (const state of STATES) for (const gateSkipped of BOOLS)
      for (const knownMinor of BOOLS) for (const pdfOpened of BOOLS) {
        const facts = { shopify, state, gateSkipped, knownMinor, pdfOpened };
        expect(storagePulse(facts), JSON.stringify(facts)).toBe(todayPulse(facts));
      }
  });
});
