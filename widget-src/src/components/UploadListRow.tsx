// One row of the web upload list (US-13 AC26, web list PR 2): drawn from the engine's `ListRow` alone. The row decides
// nothing: its status, caption, reasons, error, whether its input takes typing and whether it offers Replace are the
// engine's. Its input shows `value`, which the list works out from its draft (UploadList.tsx); while a draft is open on it,
// `draftLabel` is the unit label the draft was typed under, drawn in place of the row's unit and its controls.
import { useId } from 'react';
import type { CellUnit } from '@roadmap/health-core/cell-unit';
import type { ChoiceChange } from '@roadmap/health-core/upload-choices';
import type { ListRow } from '@roadmap/health-core/upload-list';
import type { LpaUnit, MetricType } from '@roadmap/health-core/units';
import { REVIEW_CELL_TEXT } from '@roadmap/health-core/upload-text';
import { describedBy } from '../lib/aria';
import { rowName } from '../lib/upload-list-names';
import { LpaUnitControl } from './LpaUnitControl';
import { insertedText } from './NumericInputCell';
import { UnitChip } from './UnitChip';

export interface RowEvents {
  /** `unit`, `unitLabel`: the unit on screen as the person types; the draft keeps the first. */
  type: (key: string, text: string, unit: CellUnit | null, unitLabel: string | null) => void;
  commit: () => void;
  focus: (key: string) => void;
  /** Escape in an input; true when there was a draft to drop. */
  escape: () => boolean;
  choose: (fileId: string, change: ChoiceChange) => void;
  /** A unit press: commits any open draft, then the web's own setters (hooks/useUnits.ts per test, lib/lpa-unit.ts for
   *  Lp(a)), read back through `unitOf`. */
  unitTo: (metric: MetricType, unit: CellUnit) => void;
  lpaUnitTo: (unit: LpaUnit) => void;
}

/** Enter commits, Escape drops the draft (and stops the key only then, so a dialog's Escape still closes it otherwise).
 *  Neither acts while an input method composes: its Enter picks a word. */
export const draftKeys = (on: RowEvents) => (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter') { e.preventDefault(); on.commit(); }
  if (e.key === 'Escape' && on.escape()) e.stopPropagation();
};

export function UploadListRow({ row, value, draftLabel, hidden, editable, on }: {
  row: ListRow; value: string; draftLabel: string | null; hidden: boolean; editable: boolean; on: RowEvents;
}) {
  const id = useId();
  const [unitId, captionId, reasonsId, errorId, labelId, heldId, proposedId] = ['unit', 'caption', 'reasons', 'error', 'label', 'held', 'proposed'].map((p) => `${id}${p}`);
  // A blocking row's caption is its error: said once.
  const caption = row.caption !== row.error ? row.caption : null;
  const held = row.replaces !== null ? row.held : null;
  const name = rowName(row);
  const type = (text: string) => on.type(row.key, text, row.unit.typeIn, row.unit.label);
  const metric = row.shown.cell?.metric;
  // An open draft draws the unit it was typed under, and no control: a press could not change what it writes (Codex R1).
  const typing = draftLabel !== null;
  const unitLabel = draftLabel ?? row.unit.label;
  const toggle = typing ? null : row.unit.toggle;
  const lpa = typing ? null : row.unit.choices && row.unit.current;
  return (
    <li className={`upload-list-row upload-list-row--${row.status.kind}`} data-key={row.key} hidden={hidden} onFocus={() => on.focus(row.key)}>
      <label className="upload-list-check">
        <input
          type="checkbox" className="upload-list-tick" checked={row.ticked} disabled={!editable}
          aria-label={name} data-at={row.input === 'none' ? row.key : undefined}
          onChange={(e) => on.choose(row.fileId, { tick: row.ref, on: e.target.checked })}
        />
        <span id={labelId} className="upload-list-label">{row.label}</span>
      </label>
      <span className={`upload-list-value${row.reasons.length ? ' bt-cell-low-confidence' : ''}`}>
        {row.input === 'number' ? (
          <input
            type="text" inputMode="decimal" size={1} className="bt-input upload-list-input" value={value} disabled={!editable}
            aria-label={name} aria-invalid={row.error !== null}
            aria-describedby={describedBy(unitId, caption && captionId, row.reasons.length > 0 && reasonsId, row.error && errorId)}
            data-at={row.key}
            onChange={(e) => type(e.target.value)}
            {...insertedText(value, type)}
            onBlur={on.commit}
            onKeyDown={draftKeys(on)}
          />
        ) : <span className="upload-list-number">{row.shown.text}</span>}
        {/* The engine's unit control: Lp(a)'s three, another test's two-way chip, else its label (held text's own unit). */}
        <span id={lpa ? undefined : unitId} className="upload-list-unit">
          {lpa ? <LpaUnitControl unit={lpa} onChange={on.lpaUnitTo} />
            : toggle && metric ? <UnitChip label={unitLabel} onToggle={() => on.unitTo(metric, toggle)} />
            : unitLabel}
        </span>
        {/* Lp(a)'s three would all be read: the input is described by the one shown (adversary F6). */}
        {lpa && <span id={unitId} className="hr-sr-only">{unitLabel}</span>}
      </span>
      {(caption || held) && (
        // The saved value leads the caption that says what happens to it; separate words for assistive tech.
        <p id={captionId} className="upload-list-caption">
          {held && <><span id={heldId} className="upload-list-held">{held}</span>{' '}</>}
          {caption}
        </p>
      )}
      {row.replaces !== null && (
        <label className="upload-list-replace">
          <input
            type="checkbox" checked={row.replacing} disabled={!editable}
            aria-label={row.replaceLabel ?? undefined}
            // Replace's label is not unique on its own: the row's label, the saved value and the proposed one tie it to its row.
            aria-describedby={describedBy(labelId, held && heldId, proposedId)}
            onChange={(e) => on.choose(row.fileId, { replace: row.ref, correctsId: e.target.checked ? row.replaces : null })}
          />
          {REVIEW_CELL_TEXT.replace}
        </label>
      )}
      {/* The value Replace would write, as text: a description names text, never an input (US-13 AC10). */}
      {row.replaces !== null && <span id={proposedId} className="hr-sr-only">{`${value} ${unitLabel}`}</span>}
      {row.reasons.length > 0 && (
        <ul id={reasonsId} className="upload-list-reasons">
          {row.reasons.map((r) => <li key={r} className="bt-cell-question upload-list-reason">{r}</li>)}
        </ul>
      )}
      {/* Announced by the list when the person's step makes it (UploadList.tsx), never on a redraw. */}
      {row.error && <p id={errorId} className="upload-list-error">{row.error}</p>}
    </li>
  );
}
