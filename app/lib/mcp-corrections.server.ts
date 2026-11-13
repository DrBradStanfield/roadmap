/**
 * The corrections guards the hosted MCP server adds before a tool runs
 * (design §3): split out of `mcp.server.ts` for size, unchanged.
 */
import { dayOf, daysBetween } from '../../packages/health-core/src/merge';
import type { GuardRefusal } from '../../packages/health-core/src/mcp-tools';
import { PROFILE_FIELDS } from '../../packages/health-core/src/mcp-tool-contract';
import type { FileLabValue, FileMeasurement, RoadmapFile } from '../../packages/health-core/src/roadmap-file';

/**
 * A correction fixes a recent mistake. A result from three years ago is
 * history, not a typo, so it is permanently out of reach of an agent — which
 * is what puts the bulk of the record beyond the silent-falsification attack
 * of design §3 (mitigation 2).
 */
export const MAX_CORRECTION_AGE_DAYS = 90;

function findRow(file: RoadmapFile, id: string): FileMeasurement | FileLabValue | undefined {
  return file.measurements.find((m) => m.id === id) ?? file.labValues.find((l) => l.id === id);
}

/**
 * The two guards the hosted surface adds to `correct_value`, both mandatory
 * (design §3). Neither belongs in the tool layer: the CLI (US-31) keeps
 * `expectedValue` optional, because there a human is watching their own file.
 */
export function checkCorrection(file: RoadmapFile, args: unknown, now: string): GuardRefusal | null {
  const request = (args ?? {}) as { id?: unknown; expectedValue?: unknown };
  if (typeof request.expectedValue !== 'number') {
    return {
      reason: 'malformed',
      text:
        'correct_value needs expectedValue on this server: the value you believe the row holds right now. ' +
        'Read the record, then correct. Nothing was written.',
    };
  }
  const row = typeof request.id === 'string' ? findRow(file, request.id) : undefined;
  if (!row) return null; // the tool layer answers "no such row" in its own words
  // UTC by choice: the server has no user timezone; both sides are calendar days.
  const age = daysBetween(dayOf(row.recordedAt ?? ''), dayOf(now));
  if (age > MAX_CORRECTION_AGE_DAYS) {
    return {
      reason: 'too-old',
      text:
        `That value was recorded ${age} days ago, and this server only corrects values from the last ` +
        `${MAX_CORRECTION_AGE_DAYS} days. Nothing was written. The user can correct older values in the app.`,
    };
  }
  return null;
}

/**
 * The same guard for `update_profile` (US-34): every field the call changes
 * must come with the value the agent believes it is replacing. The profile is
 * last-write-wins, so there is no superseded copy to read back — the claim is
 * the only thing standing between a stale read and a silently wrong plan —
 * when there IS a value to replace. Filling a field the record does not hold
 * is an add, and needs no claim about what was there (see below).
 */
export function checkProfileUpdate(args: unknown, file: RoadmapFile): GuardRefusal | null {
  const request = (args ?? {}) as Record<string, unknown>;
  const expected = (request.expected ?? {}) as Record<string, unknown>;
  // Filling a field the record does not hold is an ADD, and the record prices
  // adds cheaply everywhere else — `add_measurement` needs no expected value
  // either. `expected` exists to stop an agent overwriting a value it never
  // read; where there is no value, there is nothing to overwrite and nothing
  // for the guard to protect. Demanding it here only forced a read_record
  // before a user could say how tall they are.
  const missing = PROFILE_FIELDS.filter(
    (field) => request[field] !== undefined && expected[field] === undefined && file.profile[field] != null,
  );
  if (missing.length === 0) return null;
  return {
    reason: 'malformed',
    text:
      `update_profile needs expected.${missing.join(', expected.')} on this server: the record already holds a value ` +
      'for each of those, and changing one needs the value you believe is there now. Read the record, then update. ' +
      'Nothing was written. (A field the record does not hold yet needs no expected value.)',
  };
}
