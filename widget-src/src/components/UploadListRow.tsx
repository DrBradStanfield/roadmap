// One row of the web upload list (US-13 AC26, web list PR 2): drawn from the engine's `ListRow` alone. The row decides
// nothing: its status, caption, reasons, error, whether its input takes typing and whether it offers Replace are the
// engine's. Its input shows `value`, which the list works out from its draft (UploadList.tsx).
import { useId } from 'react';
import type { ChoiceChange } from '@roadmap/health-core/upload-choices';
import type { ListRow } from '@roadmap/health-core/upload-list';
import { REVIEW_CELL_TEXT } from '@roadmap/health-core/upload-text';
import { describedBy } from '../lib/aria';
import { rowName } from '../lib/upload-list-names';

export interface RowEvents {
  type: (key: string, text: string) => void;
  commit: () => void;
  focus: (key: string) => void;
  /** Escape in an input; true when there was a draft to drop. */
  escape: () => boolean;
  choose: (fileId: string, change: ChoiceChange) => void;
}

/** Enter commits, Escape drops the draft (and stops the key only then, so a dialog's Escape still closes it otherwise). */
export const draftKeys = (on: RowEvents) => (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter') { e.preventDefault(); on.commit(); }
  if (e.key === 'Escape' && on.escape()) e.stopPropagation();
};

export function UploadListRow({ row, value, hidden, editable, on }: { row: ListRow; value: string; hidden: boolean; editable: boolean; on: RowEvents }) {
  const id = useId();
  const [unitId, captionId, reasonsId, errorId, labelId, heldId] = ['unit', 'caption', 'reasons', 'error', 'label', 'held'].map((p) => `${id}${p}`);
  // A blocking row's caption is its error: said once.
  const caption = row.caption !== row.error ? row.caption : null;
  const name = rowName(row);
  return (
    <li className={`upload-list-row upload-list-row--${row.status.kind}`} data-key={row.key} hidden={hidden} onFocus={() => on.focus(row.key)}>
      <input
        type="checkbox" className="upload-list-tick" checked={row.ticked} disabled={!editable}
        aria-label={name} data-at={row.input === 'none' ? row.key : undefined}
        onChange={(e) => on.choose(row.fileId, { tick: row.ref, on: e.target.checked })}
      />
      <span id={labelId} className="upload-list-label">{row.label}</span>
      <span className="upload-list-value">
        {row.input === 'number' ? (
          <input
            type="text" inputMode="decimal" size={1} className="bt-input upload-list-input" value={value} disabled={!editable}
            aria-label={name} aria-invalid={row.error !== null}
            aria-describedby={describedBy(unitId, caption && captionId, row.reasons.length > 0 && reasonsId, row.error && errorId)}
            data-at={row.key}
            onChange={(e) => on.type(row.key, e.target.value)}
            onBlur={on.commit}
            onKeyDown={draftKeys(on)}
          />
        ) : <span className="upload-list-number">{row.shown.text}</span>}
        <span id={unitId} className="upload-list-unit">{row.shown.unit}</span>
      </span>
      {row.replaces !== null && (
        <label className="upload-list-replace">
          <input
            type="checkbox" checked={row.replacing} disabled={!editable}
            aria-label={row.replaceLabel ?? undefined}
            // Replace's label is not unique on its own: the row's label and the saved value tie it to its row.
            aria-describedby={describedBy(labelId, row.held !== null && heldId)}
            onChange={(e) => on.choose(row.fileId, { replace: row.ref, correctsId: e.target.checked ? row.replaces : null })}
          />
          {REVIEW_CELL_TEXT.replace}
        </label>
      )}
      {(caption || row.held) && (
        // The saved value sits beside the caption that says what happens to it.
        <p id={captionId} className="upload-list-caption">
          {row.replaces !== null && row.held !== null && <span id={heldId} className="upload-list-held">{row.held}</span>}
          {caption}
        </p>
      )}
      {row.reasons.length > 0 && (
        <ul id={reasonsId} className="upload-list-reasons">
          {row.reasons.map((r) => <li key={r} className="bt-cell-question upload-list-reason">{r}</li>)}
        </ul>
      )}
      {row.error && <p id={errorId} className="upload-list-error">{row.error}</p>}
    </li>
  );
}
