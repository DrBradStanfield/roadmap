// The web upload list's day controls (US-13 AC24, US-12 AC14; web list PR 2): one per `uploadList` day control, in the
// engine's order and by its stable key. A full date goes to the engine as typed; an emptied one is ignored. The input
// shows the pick as given, else the day the values save on; a pick the engine refuses never shows.
import { useId } from 'react';
import type { ChoiceChange } from '@roadmap/health-core/upload-choices';
import type { DayControl } from '@roadmap/health-core/upload-list';
import { longDate, UPLOAD_TEXT } from '@roadmap/health-core/upload-text';

/** The undated previous column's words, as ReviewTable.tsx `pickHints` writes them (no shared string yet). */
const previousWords = (month: string | null, before: string | null) =>
  `Pick a day${month ? ` in ${longDate(month)}` : ''}${before ? ` before ${longDate(before)}` : ''}`;

function words(c: DayControl): string {
  if (c.source === 'test') return UPLOAD_TEXT.dayOfTest;
  if (c.source === 'previous') return previousWords(c.month, c.before);
  return `${UPLOAD_TEXT.dayOfTest} (${longDate(c.printed) ?? c.printed})`;
}

function change(c: DayControl, day: string): ChoiceChange {
  if (c.source === 'test') return { testDay: day };
  if (c.source === 'previous') return { previousDay: day };
  return { columnDay: c.printed, day };
}

function Day({ control, name, editable, choose }: { control: DayControl; name: string; editable: boolean; choose: (fileId: string, change: ChoiceChange) => void }) {
  const id = useId();
  return (
    <li className="upload-list-day">
      <label htmlFor={`${id}day`} className="upload-list-day-words">{words(control)}</label>
      <span id={`${id}file`} className="upload-list-day-file">{name}</span>
      <input
        id={`${id}day`} type="date" className="upload-list-day-input" data-at={control.key} disabled={!editable}
        aria-describedby={`${id}file`} value={control.chosen ?? control.day ?? ''}
        onChange={(e) => { if (e.target.value) choose(control.fileId, change(control, e.target.value)); }}
      />
    </li>
  );
}

export function UploadListDays({ days, names, editable, choose }: { days: DayControl[]; names: ReadonlyMap<string, string>; editable: boolean; choose: (fileId: string, change: ChoiceChange) => void }) {
  if (!days.length) return null;
  return (
    <ul className="upload-list-days">
      {days.map((d) => <Day key={d.key} control={d} name={names.get(d.fileId) ?? ''} editable={editable} choose={choose} />)}
    </ul>
  );
}
