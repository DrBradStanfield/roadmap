// The refused-spelling counter (US-21 AC15), apart from the store so the
// upload flow can count the labs its review never sent (US-13 AC13).
import type { LabUnitRefusal } from '@roadmap/health-core/record-edits';
import { labUnitForEvent } from '@roadmap/health-core/product-events';
import { labUnitTaken, resolveLabCatalogEntry } from '@roadmap/health-core/lab-catalog';
import { trackProductEvent } from './server-api';

/** Every lab writer passes here, so each refused row is counted once: only a spelling the test
 *  does not take, the signal for the next one to teach it (US-21 AC15). A unit that is not a unit
 *  word is counted without it (US-21 AC11); a blank one as `(blank)` (AC22). */
export function countRefusedSpellings(refused: LabUnitRefusal[]): void {
  for (const row of refused) {
    if (!labUnitTaken(resolveLabCatalogEntry(row.key), row.unit)) {
      const unit = labUnitForEvent(row.unit);
      trackProductEvent('lab_unit_refused', unit ? { key: row.key, unit } : { key: row.key });
    }
  }
}
