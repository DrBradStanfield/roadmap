// A day control of the web upload list (US-13 AC24, US-12 AC14; web list PR 2), heading the rows that printed on its
// day: the engine's label, printed day, file name and hint, and a picker named by the label (the names constant) and
// described by the hint and file. A pick the engine refuses never shows.
import { useId } from 'react';
import type { ChoiceChange } from '@roadmap/health-core/upload-choices';
import type { DayControl } from '@roadmap/health-core/upload-list';
import { longDate } from '@roadmap/health-core/upload-text';
import { describedBy } from '../lib/aria';
import { dayName } from '../lib/upload-list-names';
import { ListDatePicker } from './UploadListDatePicker';

function change(c: DayControl, day: string): ChoiceChange {
  if (c.source === 'test') return { testDay: day };
  if (c.source === 'previous') return { previousDay: day };
  return { columnDay: c.printed, day };
}

export function DayHeader({ control: c, editable, choose }: { control: DayControl; editable: boolean; choose: (fileId: string, change: ChoiceChange) => void }) {
  const id = useId();
  // TODO(engine): what a pick the engine still waits on shows. Until it says, the pick as given, else the day the values
  // save on, else (a dated column) the day it printed: a screen-made fallback, pinned by an it.todo (UploadList.round3.test.tsx).
  const value = c.chosen ?? c.day ?? (c.source === 'column' ? c.printed : '');
  const empty = c.day === null;
  return (
    <div className={`upload-list-day${c.hint ? ' upload-list-day--asks' : ''}`}>
      <span className="upload-list-day-words">{c.label}</span>
      {c.source === 'column' && <span className="upload-list-day-printed">{c.printedLine}</span>}
      <span id={`${id}file`} className="upload-list-day-file">{c.fileName}</span>
      <span className="upload-list-day-input">
        <ListDatePicker
          value={empty ? '' : value} empty={empty} at={c.key} name={dayName(c)} disabled={!editable}
          shown={{ id: `${id}shown`, text: empty && c.hint ? c.hint : longDate(value) ?? value }}
          describedBy={describedBy(empty && c.hint && `${id}shown`, `${id}file`)}
          onDay={(day) => choose(c.fileId, change(c, day))}
        />
      </span>
    </div>
  );
}
