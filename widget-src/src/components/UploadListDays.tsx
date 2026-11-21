// The web upload list's day controls (US-13 AC24, US-12 AC14; web list PR 2): one per `uploadList` day control, in the
// engine's order and by its stable key, each with the engine's label, printed day, hint and file name. The picker is the
// grid's own (DraftDateCell): with no day it starts empty and shows the hint, never a day that reads as picked. A full
// date goes to the engine as given; an emptied one is ignored. A pick the engine refuses never shows.
import type { ChoiceChange } from '@roadmap/health-core/upload-choices';
import type { DayControl } from '@roadmap/health-core/upload-list';
import { dayName } from '../lib/upload-list-names';
import { DraftDateCell } from './DraftDateCell';

function change(c: DayControl, day: string): ChoiceChange {
  if (c.source === 'test') return { testDay: day };
  if (c.source === 'previous') return { previousDay: day };
  return { columnDay: c.printed, day };
}

export function UploadListDays({ days, editable, choose }: { days: DayControl[]; editable: boolean; choose: (fileId: string, change: ChoiceChange) => void }) {
  if (!days.length) return null;
  return (
    <ul className="upload-list-days">
      {days.map((c) => (
        <li key={c.key} className="upload-list-day">
          <span className="upload-list-day-words">{c.label}</span>
          {c.source === 'column' && <span className="upload-list-day-printed">{c.printedLine}</span>}
          <span className="upload-list-day-file">{c.fileName}</span>
          {/* The picker shows the pick as given (one the engine waits on included), else the day the values save on. */}
          <span className="upload-list-day-input" data-at={c.key}>
            <DraftDateCell
              date={c.chosen ?? c.day ?? (c.source === 'column' ? c.printed : '')}
              needsDay={c.day === null}
              placeholder={c.hint ?? undefined}
              ariaLabel={dayName(c)}
              disabled={!editable}
              onChange={(day) => { if (day) choose(c.fileId, change(c, day)); }}
            />
          </span>
        </li>
      ))}
    </ul>
  );
}
