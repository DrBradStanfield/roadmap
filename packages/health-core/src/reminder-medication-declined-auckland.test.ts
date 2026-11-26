// US-23 AC17 + AC6b in Pacific/Auckland, where the local day runs ahead of the UTC day.
// Per-file pin: vitest.config runs every file in its own `forks` child, which picks up the zone.
process.env.TZ = 'Pacific/Auckland';

import { declinedMedicationReviewCases } from './reminder-medication-declined.cases';

declinedMedicationReviewCases('Pacific/Auckland');
