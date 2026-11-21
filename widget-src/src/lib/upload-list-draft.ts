/**
 * The one thing the web upload list owns (US-13 AC26, web list PR 2): the text typed into the focused input and not yet
 * sent to the engine. Everything else the screen shows is the engine's (`uploadList`, `uploadView`). Changed only
 * through this pure `transition`; `send` is a draft the screen hands the engine (a row's `{typed: ref, text, unit}`, a
 * letter's title). `unit`: the unit on screen when the typing started, kept to the commit (Codex R2), null for a lab or a
 * title; `unitLabel`: its words, drawn beside the input while the draft is open, so the label never names a unit the
 * commit does not write (Codex R1).
 */
import type { CellUnit } from '@roadmap/health-core/cell-unit';

export type Draft = null | { key: string; text: string; unit: CellUnit | null; unitLabel: string | null };

export type DraftEvent =
  /** `unit`, `unitLabel`: the unit the row shows now; read only when this starts a draft. */
  | { type: 'type'; key: string; text: string; unit: CellUnit | null; unitLabel: string | null }
  /** Blur, Enter, or a Save press. */
  | { type: 'commit' }
  /** A control of row `key` took the focus. */
  | { type: 'focus'; key: string }
  | { type: 'escape' }
  /** The inputs that take typing now, from the engine. */
  | { type: 'rows'; inputs: ReadonlySet<string> };

export interface DraftStep { draft: Draft; send: Draft }

export function transition(draft: Draft, e: DraftEvent): DraftStep {
  switch (e.type) {
    case 'type':
      // The same input: its text changes, its unit stays. Another input: the old draft is committed first, never lost.
      if (draft && draft.key === e.key) return { draft: { ...draft, text: e.text }, send: null };
      return { draft: { key: e.key, text: e.text, unit: e.unit, unitLabel: e.unitLabel }, send: draft };
    case 'commit': return { draft: null, send: draft };
    case 'focus': return draft && draft.key !== e.key ? { draft: null, send: draft } : { draft, send: null };
    case 'escape': return { draft: null, send: null };
    case 'rows': return draft && !e.inputs.has(draft.key) ? { draft: null, send: null } : { draft, send: null };
  }
}
