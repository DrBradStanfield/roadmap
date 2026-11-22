// One row of the web upload list (US-13 AC26, web list PR 2): drawn from the engine's `ListRow` alone. The row decides
// nothing: its status, caption, reasons, error, whether its input takes typing and whether it offers Replace are the
// engine's. Its input shows `value`, which the list works out from its draft (UploadList.tsx); while a draft is open on it,
// `draftLabel` is the unit label the draft was typed under, drawn in place of the row's unit and its controls.
import { useId, useRef } from 'react';
import type { CellUnit } from '@roadmap/health-core/cell-unit';
import type { ChoiceChange } from '@roadmap/health-core/upload-choices';
import type { ListRow } from '@roadmap/health-core/upload-list';
import type { LpaUnit, MetricType } from '@roadmap/health-core/units';
import { REVIEW_CELL_TEXT } from '@roadmap/health-core/upload-text';
import { describedBy } from '../lib/aria';
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

/**
 * A checkbox that acts on what the person saw when they pressed it (Codex at 8cb68bc78). A press on a row's tick or
 * Replace blurs the row's input first, and that commit can flip the same box (an emptied input unticks its row); the
 * click would then toggle the new state. So the intent is claimed at pointerdown on its label, or Space on the box, from
 * the state drawn then, and sent instead of the box's post-commit state; the commit still runs first. A synchronous claim,
 * good for the next change of this box only: a cancelled press (pointercancel, the pointer leaving, the box's blur)
 * drops it, so a later click with no press of its own (assistive tech, `.click()`) sends the box's own state.
 */
function usePress(checked: boolean, act: (on: boolean) => void) {
  const intent = useRef<boolean | null>(null);
  const claim = () => { intent.current = !checked; };
  const drop = () => { intent.current = null; };
  return {
    label: { onPointerDown: claim, onPointerCancel: drop, onPointerLeave: drop },
    box: {
      checked,
      onKeyDown: (e: React.KeyboardEvent) => { if (e.key === ' ') claim(); },
      onBlur: drop,
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => { const on = intent.current ?? e.target.checked; drop(); act(on); },
    },
  };
}

export function UploadListRow({ row, value, draftLabel, hidden, editable, on }: {
  row: ListRow; value: string; draftLabel: string | null; hidden: boolean; editable: boolean; on: RowEvents;
}) {
  const id = useId();
  const [unitId, captionId, reasonsId, errorId, labelId, heldId, proposedId, printedId] = ['unit', 'caption', 'reasons', 'error', 'label', 'held', 'proposed', 'printed'].map((p) => `${id}${p}`);
  // A blocking row's caption is its error: said once.
  const caption = row.caption !== row.error ? row.caption : null;
  const held = row.replaces !== null ? row.held : null;
  const name = row.name;
  const type = (text: string) => on.type(row.key, text, row.unit.typeIn, row.unit.label);
  const metric = row.shown.cell?.metric;
  // An open draft draws the unit it was typed under, and no control: a press could not change what it writes (Codex R1).
  const typing = draftLabel !== null;
  const proposing = !typing && row.typed === null;
  const unitLabel = draftLabel ?? row.unit.label;
  const toggle = typing ? null : row.unit.toggle;
  const lpa = typing ? null : row.unit.choices && row.unit.current;
  const tick = usePress(row.ticked, (ticked) => on.choose(row.fileId, { tick: row.ref, on: ticked }));
  const replace = usePress(row.replacing, (replacing) => on.choose(row.fileId, { replace: row.ref, correctsId: replacing ? row.replaces : null }));
  return (
    <li className={`upload-list-row upload-list-row--${row.status.kind}`} data-key={row.key} hidden={hidden} onFocus={() => on.focus(row.key)}>
      <label className="upload-list-check" {...tick.label}>
        <input
          type="checkbox" className="upload-list-tick" disabled={!editable}
          aria-label={name} data-at={row.input === 'none' ? row.key : undefined}
          {...tick.box}
        />
        <span id={labelId} className="upload-list-label">{row.label}</span>
      </label>
      <span className={`upload-list-value${row.reasons.length ? ' bt-cell-low-confidence' : ''}`}>
        {row.input === 'number' ? (
          <input
            type="text" inputMode="decimal" size={1} className="bt-input upload-list-input" value={value} disabled={!editable}
            aria-label={name} aria-invalid={row.error !== null}
            aria-describedby={describedBy(unitId, row.printed && printedId, caption && captionId, row.reasons.length > 0 && reasonsId, row.error && errorId)}
            data-at={row.key}
            onChange={(e) => type(e.target.value)}
            {...insertedText(value, type)}
            onBlur={on.commit}
            onKeyDown={draftKeys(on)}
          />
        ) : <span className="upload-list-number">{row.shown.text}</span>}
        {/* The engine's unit control: Lp(a)'s three, another test's two-way chip, else its label (held text's own unit). */}
        <span id={lpa ? undefined : unitId} className="upload-list-unit">
          {/* No unit press while the engine says the review takes none (saving, say). */}
          {lpa ? <LpaUnitControl unit={lpa} disabled={!editable} onChange={(u) => { if (editable) on.lpaUnitTo(u); }} />
            : toggle && metric ? <UnitChip label={unitLabel} disabled={!editable} onToggle={() => { if (editable) on.unitTo(metric, toggle); }} />
            : <span className="upload-list-unit-text">{unitLabel}</span>}
        </span>
        {/* Lp(a)'s three would all be read: the input is described by the one shown (adversary F6). */}
        {lpa && <span id={unitId} className="hr-sr-only">{unitLabel}</span>}
      </span>
      {/* What the report printed, while the row shows another number or a guessed unit: the grid's note (US-13 AC11). */}
      {row.printed && <p id={printedId} className="bt-cell-printed upload-list-printed">{row.printed}</p>}
      {(caption || held) && (
        // The saved value leads the caption that says what happens to it; separate words for assistive tech.
        <p id={captionId} className="upload-list-caption">
          {held && <><span id={heldId} className="upload-list-held">{held}</span>{' '}</>}
          {caption}
        </p>
      )}
      {row.replaces !== null && (
        <label className="upload-list-replace" {...replace.label}>
          <input
            type="checkbox" disabled={!editable} {...replace.box}
            aria-label={row.replaceLabel ?? undefined}
            // Replace's label is not unique on its own: the row's label, the saved value and the proposed one tie it to its row.
            aria-describedby={describedBy(labelId, held && heldId, proposing && proposedId)}
          />
          {REVIEW_CELL_TEXT.replace}
        </label>
      )}
      {/* The value Replace would write, as the engine shows it: a description names text, never an input (US-13 AC10).
          None while the row holds text or a draft: that text is no value Replace could write (adversary R4). */}
      {row.replaces !== null && proposing && <span id={proposedId} className="hr-sr-only">{`${row.shown.text} ${row.unit.label}`}</span>}
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
