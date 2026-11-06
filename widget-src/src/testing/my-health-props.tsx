// Test support: My health around InputPanel alone (US-62 phase 5), with an empty
// plan, for the suites that test the form. Imported by tests only.
import type { PlanView } from '../components/ResultsPanel';
import { MyHealth, type FormSlots, type MyHealthProps } from '../components/MyHealth';

export const NO_PLAN: PlanView = {
  layout: { sections: [], medicines: [], screenings: [] },
  topics: new Map(),
  planned: false,
  highlights: { highlighted: new Set(), fadingOut: new Set() },
  urgent: null,
  supplementsRef: { current: null },
  foot: null,
  attention: false,
  onErased: () => {},
  report: null,
};

/** InputPanel's `children`: My health with an empty plan; `page` overrides any of its props (Settings open, say). */
export function myHealth(page: Partial<Omit<MyHealthProps, 'form'>> = {}) {
  return {
    children: (form: FormSlots) => (
      <MyHealth form={form} plan={NO_PLAN} tiles={[]} series={{ whtr: [], egfr: [] }} egfrCurrent={null}
                settingsOpen={false} onSettingsClose={() => {}} onDelete={() => {}} {...page}/>
    ),
  };
}

export const MY_HEALTH_PROPS = myHealth();
