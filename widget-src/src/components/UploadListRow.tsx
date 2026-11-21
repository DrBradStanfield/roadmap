// One row of the web upload list (US-13 AC26, web list PR 2): drawn from the engine's `ListRow` alone. The row decides
// nothing: its status, caption, error, whether its input takes typing and whether it offers Replace are the engine's.
// Its input shows `value`, which the list works out from its draft (UploadList.tsx).
import { useId } from 'react';
import type { ChoiceChange } from '@roadmap/health-core/upload-choices';
import type { ListRow } from '@roadmap/health-core/upload-list';
import { REVIEW_CELL_TEXT } from '@roadmap/health-core/upload-text';
import { describedBy } from '../lib/aria';

export interface RowEvents {
  type: (key: string, text: string) => void;
  commit: () => void;
  focus: (key: string) => void;
  /** Escape in the input; true when there was a draft to drop. */
  escape: (key: string) => boolean;
  choose: (fileId: string, change: ChoiceChange) => void;
}

export function UploadListRow({ row, value, hidden, editable, on }: { row: ListRow; value: string; hidden: boolean; editable: boolean; on: RowEvents }) {
  const id = useId();
  const [unitId, captionId, errorId, labelId, heldId] = ['unit', 'caption', 'error', 'label', 'held'].map((p) => `${id}${p}`);
  // A blocking row's caption is its error: said once.
  const caption = row.caption !== row.error ? row.caption : null;
  const blocker = row.input === 'number' ? 'input' : 'tick';
  return (
    <li className={`upload-list-row upload-list-row--${row.status.kind}`} data-key={row.key} hidden={hidden} onFocus={() => on.focus(row.key)}>
      <input
        type="checkbox" className="upload-list-tick" checked={row.ticked} disabled={!editable}
        aria-label={row.label} data-at={blocker === 'tick' ? row.key : undefined}
        onChange={(e) => on.choose(row.fileId, { tick: row.ref, on: e.target.checked })}
      />
      <span id={labelId} className="upload-list-label">{row.label}</span>
      {row.input === 'number' ? (
        <span className="upload-list-value">
          <input
            type="text" inputMode="decimal" size={1} className="bt-input upload-list-input" value={value} disabled={!editable}
            aria-label={row.label} aria-invalid={row.error !== null}
            aria-describedby={describedBy(unitId, caption && captionId, row.error && errorId)}
            data-at={row.key}
            onChange={(e) => on.type(row.key, e.target.value)}
            onBlur={on.commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); on.commit(); }
              // Only a draft to drop stops the key, so a dialog's Escape still closes it otherwise.
              if (e.key === 'Escape' && on.escape(row.key)) e.stopPropagation();
            }}
          />
          <span id={unitId} className="upload-list-unit">{row.shown.unit}</span>
        </span>
      ) : (
        <span className="upload-list-value">
          <span className="upload-list-number">{row.shown.text}</span>
          <span id={unitId} className="upload-list-unit">{row.shown.unit}</span>
        </span>
      )}
      {row.replaces !== null && (
        <span className="upload-list-replace">
          {row.held !== null && <span id={heldId} className="upload-list-held">{row.held}</span>}
          <label>
            <input
              type="checkbox" checked={row.replacing} disabled={!editable}
              aria-describedby={describedBy(labelId, row.held !== null && heldId)}
              onChange={(e) => on.choose(row.fileId, { replace: row.ref, correctsId: e.target.checked ? row.replaces : null })}
            />
            {REVIEW_CELL_TEXT.replace}
          </label>
        </span>
      )}
      {caption && <p id={captionId} className="upload-list-caption">{caption}</p>}
      {row.error && <p id={errorId} className="upload-list-error">{row.error}</p>}
    </li>
  );
}
