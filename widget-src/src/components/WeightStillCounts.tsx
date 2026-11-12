// The lines about a saved reading under an open field: "Previous:" or "Replaces"
// over a typed value, and, under the onboarding's height and weight row, what
// the plan still uses once a saved weight is cleared from its box (US-62 AC38).
import type { MouseEvent } from 'react';
import type { ApiMeasurement } from '@roadmap/health-core/mappings';
import { dayOf, localDay } from '@roadmap/health-core/merge';
import { formatShortDate } from '../lib/constants';
import type { ValueSubject } from './MyDataRows';

const savedToday = (recordedAt: string) => dayOf(recordedAt) === localDay(new Date());

/** The line over an open field whose metric holds a saved value: "Previous:
 *  82 kg · 3 Sep", or "Replaces 82 kg" when that value is today's, since one
 *  day holds one value and what is typed here corrects it (US-03 AC3). */
export const previousReference = (shown: string, recordedAt: string): string =>
  savedToday(recordedAt) ? `Replaces ${shown}` : `Previous: ${shown} · ${formatShortDate(recordedAt)}`;

/** The weight box's description while it shows. */
export const WEIGHT_STILL_COUNTS_ID = 'weight-still-counts';

/** A saved weight cleared from the box and left: clearing writes nothing, so
 *  the plan still uses it. Its value page is where a reading is corrected. */
export function WeightStillCounts({ previous, shown, onOpen }: {
  previous: ApiMeasurement | undefined;
  /** The saved value in the person's unit: "78 kg". */
  shown: string;
  onOpen: (subject: ValueSubject, from?: Element) => void;
}) {
  if (!previous) return null;
  const open = (e: MouseEvent<HTMLAnchorElement>) => { e.preventDefault(); onOpen({ kind: 'core', metric: 'weight' }, e.currentTarget); };
  return (
    <p id={WEIGHT_STILL_COUNTS_ID} className="weight-still-counts">
      {savedToday(previous.recordedAt)
        ? `Your plan still uses today's ${shown}. Type a new weight, or correct it in your `
        : `Your plan still uses ${shown} from ${formatShortDate(previous.recordedAt)}. Type a new weight, or correct this one in your `}
      <a href="#health-history" onClick={open}>weight history</a>.
    </p>
  );
}
