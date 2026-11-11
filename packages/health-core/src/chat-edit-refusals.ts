/**
 * Which parts of a chat reply's edits are refused as unreadable (US-67 AC2),
 * shared by the web and the iPhone engine so both refuse the same parts with
 * the same words. A reply has two parts: its medication changes, and its
 * review (measurement values and the profile). One entry of a part that is not
 * its shape refuses that whole part; the other part still applies.
 */
import type { ProposedEdit } from './chat-edits';

export const CHAT_EDIT_UNREADABLE = 'The chat\'s suggestion could not be read, so nothing was saved.';
export const CHAT_MEDS_UNREADABLE = 'The chat\'s medication change could not be read, so nothing was saved.';

export type ChatEditPart = 'medications' | 'review';
export interface ChatEditRefusal { part: ChatEditPart; words: string }
/** `readProposedEdits`' `invalid`: the kinds whose entries were not their shape, or 'list'. */
type Invalid = ReadonlyArray<string>;

const PART_OF: Record<string, ChatEditPart | undefined> = { medication: 'medications', field: 'review', profile: 'review' };

/** The words refusing `part`, or null when nothing in it is unreadable. A list that is not one refuses both. */
export function partRefusal(invalid: Invalid, part: ChatEditPart): string | null {
  if (!invalid.some((k) => k === 'list' || PART_OF[k] === part)) return null;
  return part === 'medications' ? CHAT_MEDS_UNREADABLE : CHAT_EDIT_UNREADABLE;
}

/**
 * `readProposedEdits`' result, with every edit of a refused part left out and
 * one refusal per refused part, medications first. A list that is not one is
 * said once, as the review's refusal, as the iPhone shows it.
 */
export function refuseUnreadableEdits(read: { edits: ProposedEdit[]; invalid: Invalid }): { edits: ProposedEdit[]; refusals: ChatEditRefusal[] } {
  const refused = (['medications', 'review'] as const).filter((part) => partRefusal(read.invalid, part) !== null);
  const refusals = refused
    .filter((part) => !(part === 'medications' && read.invalid.includes('list')))
    .map((part) => ({ part, words: partRefusal(read.invalid, part)! }));
  return { edits: read.edits.filter((e) => !refused.some((part) => part === PART_OF[e.kind])), refusals };
}
