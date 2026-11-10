// @vitest-environment jsdom
/**
 * US-62 AC12: About you travels to the foot (FLIP) only when leaving its card
 * moves it. The cards are measured as the card is left, before the move
 * commits; a leave that moves nothing measures nothing, so a later move (an
 * erase, then a record complete when shown) never animates from stale places.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { InputPanel } from './InputPanel';
import { myHealth } from '../testing/my-health-props';

vi.mock('../lib/server-api', async importOriginal => ({ ...await importOriginal<typeof import('../lib/server-api')>(), trackProductEvent: vi.fn() }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));

const animate = vi.fn();
beforeEach(() => {
  animate.mockClear();
  (Element.prototype as unknown as { animate: typeof animate }).animate = animate;
});
afterEach(() => {
  cleanup();
  delete (Element.prototype as unknown as { animate?: unknown }).animate;
});
vi.stubGlobal('matchMedia', (q: string) => ({ matches: !q.includes('max-width') && !q.includes('reduced-motion'), media: q, addEventListener() {}, removeEventListener() {} }));

const inputs = { sex: 'male' as const, heightCm: 180, birthYear: 1960, birthMonth: 1 };
const props = (aboutYouLow: boolean, stage: 3 | 4, profileLeft: () => boolean) => ({
  ...myHealth({ settingsOpen: true }),
  inputs, effectiveInputs: inputs, onChange: vi.fn(), errors: {}, unitSystem: 'si' as const, onUnitSystemChange: vi.fn(),
  unitOverrides: {}, onToggleFieldUnit: vi.fn(), previousMeasurements: [], bloodTestHistory: [], vitalsHistory: [],
  labValues: [], onSaveBloodTestBatch: vi.fn(async () => new Map()), onDraftValue: vi.fn(), medications: [],
  onMedicationChange: vi.fn(), onScreeningChange: vi.fn(), supplements: [], onSupplementChange: vi.fn(), screenings: [],
  onSupplementDelete: vi.fn(), scheduleLongitudinalSave: vi.fn(), flushLongitudinalSave: vi.fn(), isSavingLongitudinal: false,
  fieldsSaved: 0, hasApiResponse: true, planBasis: { age: 66 }, grading: {},
  onboarding: { stage, reached: stage, fullForm: true, aboutYouLow, profileLeft },
}) as unknown as Parameters<typeof InputPanel>[0];

/** The focus leaves the About you card from its height field. */
function leaveCard(container: HTMLElement) {
  const height = container.querySelector<HTMLInputElement>('.about-card #heightCm');
  if (!height) throw new Error('no height field in the About you card');
  act(() => height.focus());
  act(() => height.blur());
}
/** About you's rows fade in as it travels: the FLIP ran. */
const flipped = () => animate.mock.calls.some(([frames]) => JSON.stringify(frames).includes('opacity'));

it('US-62 AC12: leaving the card when it moves measures the cards, and the move animates', () => {
  const profileLeft = vi.fn(() => true);
  const view = render(<InputPanel {...props(false, 4, profileLeft)} />);
  leaveCard(view.container);
  expect(profileLeft).toHaveBeenCalledTimes(1);
  view.rerender(<InputPanel {...props(true, 4, profileLeft)} />);
  expect(flipped()).toBe(true);
});

it('US-62 AC12: a leave that moves nothing measures nothing, so a later move does not animate', () => {
  const profileLeft = vi.fn(() => false);
  const view = render(<InputPanel {...props(false, 3, profileLeft)} />);
  leaveCard(view.container);
  view.rerender(<InputPanel {...props(true, 4, profileLeft)} />); // About you low by another path
  expect(flipped()).toBe(false);
});

it('US-62 AC12 (D3): the move is HealthTool\'s call: at stage 4, a leave it says moves nothing measures nothing', () => {
  const profileLeft = vi.fn(() => false);
  const view = render(<InputPanel {...props(false, 4, profileLeft)} />);
  leaveCard(view.container);
  expect(profileLeft).toHaveBeenCalledTimes(1);
  view.rerender(<InputPanel {...props(true, 4, profileLeft)} />);
  expect(flipped()).toBe(false);
});

it('US-62 AC12 (D3): with a real move, the cards are measured before it commits, so the cards below rise from where they were', () => {
  // Each element's top is its place among its siblings, so a card's top changes when About you leaves.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    return { top: [...(this.parentElement?.children ?? [])].indexOf(this) * 100 } as DOMRect;
  });
  function Moving() {
    const [low, setLow] = useState(false);
    return <InputPanel {...props(low, 4, () => { setLow(true); return true; })} />;
  }
  const view = render(<Moving />);
  leaveCard(view.container);
  expect(animate.mock.calls.some(([frames]) => /translateY\(\d+px\)/.test(JSON.stringify(frames)))).toBe(true);
});
