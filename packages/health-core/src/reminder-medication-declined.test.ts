// US-23 AC17 in UTC (CI's zone). The Auckland twin is reminder-medication-declined-auckland.test.ts.
// Per-file pin: vitest.config runs every file in its own `forks` child, which picks up the zone.
process.env.TZ = 'UTC';

import { declinedMedicationReviewCases } from './reminder-medication-declined.cases';

declinedMedicationReviewCases('UTC');
