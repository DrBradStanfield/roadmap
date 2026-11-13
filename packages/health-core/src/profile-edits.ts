/**
 * The profile write (US-34, US-54 AC5b/AC5c): who the record is about. Every
 * writer calls this one function: the MCP tool `update_profile` (hosted and
 * stdio, through `callTool`), the CLI (`get-plan --from-values`) and the
 * iPhone engine (My data's profile edit, the chat's profile part). Beside
 * `record-edits.ts` (rows) and `state-edits.ts` (current state), whose
 * `stampProfile` it writes through. Lead I-7 moved it out of mcp-tools.ts.
 *
 * Its own module, not in state-edits.ts: the web widget imports state-edits,
 * and this one brings the tool contract's schemas with it.
 *
 * Nothing here reads the clock, the filesystem or the network.
 */
import { PROFILE_FIELDS, type ToolOutcome, type updateProfileInput } from './mcp-tool-contract';
import { oneLine } from './plan';
import { readableView } from './readable-rows';
import type { RoadmapFile, RoadmapProfile } from './roadmap-file';
import { stampProfile } from './state-edits';
import { BIRTH_IN_FUTURE, birthInFuture, healthInputSchema, zod3Message } from './validation';
import type * as z from './zod';

/**
 * The first profile value a person at the form could not type, in plain words
 * ending with a full stop: the app's own ranges, then a birth month after this
 * one (US-54 AC5b, `birthInFuture`). A year alone is judged with the stored
 * month, and a month alone with the stored year.
 */
function profileFault(
  file: RoadmapFile,
  request: Partial<Record<(typeof PROFILE_FIELDS)[number], unknown>>,
  now: string,
): { field: (typeof PROFILE_FIELDS)[number]; message: string } | undefined {
  for (const field of PROFILE_FIELDS) {
    if (request[field] === undefined) continue;
    const parsed = healthInputSchema.shape[field].safeParse(request[field], { error: zod3Message });
    if (!parsed.success) return { field, message: `${oneLine(parsed.error.issues[0]?.message ?? 'out of range')}.` };
  }
  if (request.birthYear === undefined && request.birthMonth === undefined) return undefined;
  const year = (request.birthYear ?? file.profile.birthYear) as number | undefined;
  const month = (request.birthMonth ?? file.profile.birthMonth ?? 1) as number;
  if (year === undefined || !birthInFuture(year, month, now)) return undefined;
  return { field: request.birthMonth === undefined ? 'birthYear' : 'birthMonth', message: BIRTH_IN_FUTURE };
}

/**
 * Change who the record is about: sex, birth year, birth month, height (US-34).
 *
 * Each profile field is last-write-wins: `mergeFiles` picks each field's
 * newest write (US-10 AC6), and this stamps only the fields it changes. It is
 * a read-modify-write of the object the record already holds, so every field
 * it carries survives, named or not, known to this version or not. What makes
 * that safe against a second writer is `expected`: the agent states what it
 * believes it is replacing, and a mismatch writes nothing. Optional here (a
 * person watching their own file); on the hosted server it is required to
 * CHANGE a field the record holds, and not to fill one it does not — there is
 * no earlier value to protect.
 */
export function updateProfile(
  file: RoadmapFile,
  request: z.infer<typeof updateProfileInput>,
  now: string,
): ToolOutcome {
  const named = PROFILE_FIELDS.filter((field) => request[field] !== undefined);
  if (named.length === 0) {
    return { status: 'rejected', text: `Name at least one of ${PROFILE_FIELDS.join(', ')}. Nothing was written.` };
  }

  const stored = file.profile;
  for (const field of PROFILE_FIELDS) {
    const claim = request.expected?.[field] ?? undefined;
    if (request.expected && field in request.expected && claim !== (stored[field] ?? undefined)) {
      // The refusal must not become a read: an agent that guessed wrong learns
      // nothing about what the record actually holds (design §3).
      return { status: 'rejected', text: `The record does not hold the ${field} you expected. Read the record, then update. Nothing was written.` };
    }
  }

  // After the expectations: the future-month rule reads stored fields (US-32 AC5/AC22).
  // The agent gets the field key and tail; the iPhone shows `message` as it is (US-54 AC5c).
  const fault = profileFault(file, request, now);
  if (fault) return { status: 'rejected', text: `${fault.field}: ${fault.message} Nothing was written.`, message: fault.message };

  const changed = named.filter((field) => request[field] !== stored[field]);
  if (changed.length === 0) {
    return { status: 'ok', text: 'The record already says that. Nothing was written.', data: { changed: [] } };
  }

  // The app's own write rule: the changed fields alone take a new stamp, one
  // past the copy it read. Jumping to the FILE's clock instead would make every
  // connector write beat a concurrent one made in the app, whenever it was
  // made. The merge reads wall-clock time first (US-10 AC8), the honest
  // answer to "who wrote last".
  // A stored value no reader can read is never echoed (US-65 AC3): `from` is null, the text says so.
  const shown = readableView(file).file.profile;
  const hidden = (field: (typeof PROFILE_FIELDS)[number]) => stored[field] != null && shown[field] === undefined;
  return {
    status: 'ok',
    file: stampProfile(file, Object.fromEntries(changed.map((field) => [field, request[field]])) as Partial<RoadmapProfile>, now),
    text: changed.map((field) => `${field}: ${hidden(field) ? 'a value this app cannot read' : shown[field] ?? 'not set'} → ${request[field]}`).join('\n'),
    data: {
      changed: changed.map((field) => ({ field, from: hidden(field) ? null : shown[field] ?? null, to: request[field] as string | number })),
    },
  };
}
