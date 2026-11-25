// A day control of the web upload list (US-13 AC24, US-12 AC14; web list PR 2), heading the rows that printed on its
// day: the engine's label, printed day and file name, its picker showing the engine's `picker` day, and its `hint` beside
// it. The picker is named from the text it shows: its label, a dated column's printed day, its file (US-13 AC28);
// described by its shown day and hint. `shownId`: its shown day's id, which the rows under it are named with.
import { useId } from 'react';
import type { ChoiceChange } from '@roadmap/health-core/upload-choices';
import type { DayControl } from '@roadmap/health-core/upload-list';
import { describedBy } from '../lib/aria';
import { ListDatePicker } from './UploadListDatePicker';

function change(c: DayControl, day: string): ChoiceChange {
  if (c.source === 'test') return { testDay: day };
  if (c.source === 'previous') return { previousDay: day };
  return { columnDay: c.printed, day };
}

export function DayHeader({ control: c, editable, choose, shownId, commas }: {
  control: DayControl; editable: boolean; choose: (fileId: string, change: ChoiceChange) => void; shownId: string; commas: readonly [string, string];
}) {
  const id = useId();
  const named = [`${id}words`, commas[0], ...(c.source === 'column' ? [`${id}printed`, commas[1]] : []), `${id}file`].join(' ');
  const empty = c.day === null;
  return (
    <div className={`upload-list-day${c.hint ? ' upload-list-day--asks' : ''}`}>
      <span id={`${id}words`} className="upload-list-day-words">{c.label}</span>
      {c.source === 'column' && <span id={`${id}printed`} className="upload-list-day-printed">{c.printedLine}</span>}
      <span id={`${id}file`} className="upload-list-day-file">{c.fileName}</span>
      <span className="upload-list-day-input">
        <ListDatePicker
          value={c.picker ?? ''} empty={empty} at={c.key} name={{ by: named }} disabled={!editable}
          shown={{ id: shownId, text: c.pickerLine }}
          describedBy={describedBy(c.hint && `${id}hint`)}
          onDay={(day) => choose(c.fileId, change(c, day))}
        />
      </span>
      {c.hint && <span id={`${id}hint`} className="upload-list-day-hint">{c.hint}</span>}
    </div>
  );
}
