/**
 * The one thing the web upload list owns (US-13 AC26, web list PR 2): the text typed into the focused row's input and
 * not yet sent to the engine. Everything else the screen shows is the engine's (`uploadList`, `uploadView`). Changed
 * only through this pure `transition`; `send` is a draft the screen hands the engine as `{typed: ref, text, unit}`.
 */
export type Draft = null | { key: string; text: string };

export type DraftEvent =
  | { type: 'type'; key: string; text: string }
  /** Blur, Enter, or a Save press. */
  | { type: 'commit' }
  /** A control of row `key` took the focus. */
  | { type: 'focus'; key: string }
  | { type: 'escape' }
  /** The rows whose input takes typing now, from the engine. */
  | { type: 'rows'; inputs: ReadonlySet<string> };

export interface DraftStep { draft: Draft; send: { key: string; text: string } | null }

export function transition(draft: Draft, e: DraftEvent): DraftStep {
  switch (e.type) {
    case 'type':
      // Text typed into another row: the old draft is committed first, never lost.
      return { draft: { key: e.key, text: e.text }, send: draft && draft.key !== e.key ? draft : null };
    case 'commit': return { draft: null, send: draft };
    case 'focus': return draft && draft.key !== e.key ? { draft: null, send: draft } : { draft, send: null };
    case 'escape': return { draft: null, send: null };
    case 'rows': return draft && !e.inputs.has(draft.key) ? { draft: null, send: null } : { draft, send: null };
  }
}
