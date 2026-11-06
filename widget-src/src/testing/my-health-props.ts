// Test support: the My health props InputPanel takes from HealthTool (US-62
// phase 5), empty, for the suites that render InputPanel alone to test its form.
// Imported by tests only.
import type { PlanView } from '../components/ResultsPanel';

export const NO_PLAN: PlanView = {
  layout: { sections: [], medicines: [], screenings: [] },
  highlights: { highlighted: new Set(), fadingOut: new Set() },
  urgent: null,
  supplementsRef: { current: null },
  foot: null,
  attention: false,
  onErased: () => {},
  report: null,
};

export const MY_HEALTH_PROPS = {
  plan: NO_PLAN,
  tiles: [],
  series: { whtr: [], egfr: [] },
  egfrCurrent: null,
  settingsOpen: false,
  onSettingsClose: () => {},
};
