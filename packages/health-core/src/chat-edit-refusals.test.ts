// US-67 AC2: one entry of a part that is not its shape refuses that whole part, with the iPhone's words.
import { describe, expect, it } from 'vitest';
import { readProposedEdits } from './chat-edits';
import { CHAT_EDIT_UNREADABLE, CHAT_MEDS_UNREADABLE, refuseUnreadableEdits } from './chat-edit-refusals';

const field = { kind: 'field', field: 'ldlC', displayValue: 3.4, unitSystem: 'si', date: null };
const statin = { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 40, doseUnit: 'mg' };
const badEscalation = { kind: 'medication', medicationKey: 'statin_escalation', drugName: 42, doseValue: null, doseUnit: null };
const badField = { kind: 'field', field: 'ldlC', displayValue: '3.4', unitSystem: 'si', date: null };
const profile = { kind: 'profile', sex: 'male', heightCm: 178 };
const badProfile = { kind: 'profile', sex: 'other', heightCm: null };

const run = (raw: unknown) => refuseUnreadableEdits(readProposedEdits(raw));

describe('US-67 AC2: refuseUnreadableEdits', () => {
  it.each([
    ['all readable', [field, statin, profile], [field, statin, profile], []],
    ['a malformed escalation refuses the statin beside it', [statin, badEscalation, field], [field], [{ part: 'medications', words: CHAT_MEDS_UNREADABLE }]],
    ['a wrong-typed value refuses the review, profile included', [badField, field, profile, statin], [statin], [{ part: 'review', words: CHAT_EDIT_UNREADABLE }]],
    ['a malformed profile refuses the values too', [field, badProfile], [], [{ part: 'review', words: CHAT_EDIT_UNREADABLE }]],
    ['both parts, medications first', [badField, badEscalation, statin, field], [], [
      { part: 'medications', words: CHAT_MEDS_UNREADABLE }, { part: 'review', words: CHAT_EDIT_UNREADABLE }]],
    ['an unknown kind is left out, refusing nothing', [{ kind: 'goal', target: 5 }, statin], [statin], []],
    ['a list that is not one is said once', { kind: 'field' }, [], [{ part: 'review', words: CHAT_EDIT_UNREADABLE }]],
  ])('%s', (_name, raw, edits, refusals) => {
    expect(run(raw)).toEqual({ edits, refusals });
  });
});
