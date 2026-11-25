// What a screen reader calls each value and day control on the web upload list (US-13 AC10, AC28; Brad's option 1 of
// 2026-11-23): the engine's composition (`ListRow.name`, `DayControl.name`), built only from references to text the list
// shows, never an attribute holding record text (US-09 AC7l). The list draws `rowName`'s own words once, hidden, and
// gives each file's name in Files and each day control's shown day an id. The name algorithm joins references with a
// space, so each comma is read after one, and reads each node once, so a name with two commas refers to two.
import type { ListRow } from '@roadmap/health-core/upload-list';

/** The ids a name refers to: the hidden words ("value from", ", another reading"), two commas, each file's name in Files
 *  and each day control's shown day. */
export interface ListNameIds { valueFrom: string; commas: readonly [string, string]; again: string; file: (fileId: string) => string; day: (section: string) => string }

/** A row's `aria-labelledby`: its test (`labelId`), "value from", its file, then its day while it has one, then ", another reading". */
export const rowLabelledBy = (row: Pick<ListRow, 'fileId' | 'section' | 'dayLine' | 'again'>, labelId: string, ids: ListNameIds) =>
  [labelId, ids.valueFrom, ids.file(row.fileId), ...(row.dayLine ? [ids.commas[0], ids.day(row.section)] : []), ...(row.again ? [ids.again] : [])].join(' ');
