/**
 * The words a `record-edits.ts` rejection answers in, put in the agent's own
 * terms. Split out of `mcp-tools.ts` (US-64 AC23).
 */
import { oneLine } from './plan';
import { type EditRejection } from './record-edits';
import type { FileLabValue } from './roadmap-file';
import { readableSlotRow, type ToolOutcome } from './mcp-tool-contract';

/**
 * A refusal in the agent's own terms. A taken slot is the one rejection with a
 * next move, so it names the row holding the day and sends the agent to
 * `correct_value` — the same hint `tools/edit-record.ts` prints, because an
 * agent that improvises around a slot clash writes a second active row.
 */
export function rejection(result: EditRejection): ToolOutcome {
  const held = result.existing;
  if (result.reason === 'slot-occupied' && held) {
    // A value no reader can read is never echoed (US-65 AC3): it may be anything.
    const holds = readableSlotRow(held) ? oneLine(String(held.value)) : 'a value this app cannot read';
    return {
      status: 'rejected',
      reason: result.reason,
      text: `${oneLine(result.message)}. That day already holds ${holds} in row ${oneLine(held.id)}. ` +
        'Nothing was written. To change it, call correct_value with that row id — never add a second value to the same day.',
    };
  }
  // One full stop, though a person's words (a typed correction's, US-21 AC26) already end in one.
  return { status: 'rejected', reason: result.reason, text: `${oneLine(result.message).replace(/\.$/, '')}. Nothing was written.` };
}

/**
 * The refusal of `values[index]` in an all-or-nothing `add_lab_values` call.
 * A day this call already filled is held by none of the saved rows (US-32 AC4a):
 * it names that earlier value, never an id `correct_value` cannot find.
 */
export function batchRejection(result: EditRejection, index: number, metricName: string, unsaved: FileLabValue[]): ToolOutcome {
  const which = `values[${index}] (${oneLine(metricName)})`;
  const earlier = unsaved.findIndex((row) => row.id === result.existing?.id);
  if (earlier >= 0) {
    return {
      status: 'rejected',
      reason: result.reason,
      text: `${which}: the same test and day as values[${earlier}] in this call. Send one value per test per day. No row from this call was written.`,
    };
  }
  const refusal = rejection(result);
  return { ...refusal, text: `${which}: ${refusal.text} No row from this call was written.` };
}
