// US-67 AC2: the web and the iPhone refuse the same parts of a reply with the same words.
// The web reads refuseUnreadableEdits; the phone's preview is fed the same replies.
import { describe, expect, it } from 'vitest';
import { newRecord } from './my-data';
import { chatEditsJson } from './entry';
import type { ChatEditsPreview } from './chat-edits';
import { readProposedEdits } from '../../packages/health-core/src/chat-edits';
import { refuseUnreadableEdits } from '../../packages/health-core/src/chat-edit-refusals';
import { localDay } from '../../packages/health-core/src/merge';

const NOW = '2026-11-02T08:00:00.000Z';
const field = { kind: 'field', field: 'ldlC', displayValue: 3.4, unitSystem: 'si', date: null };
const statin = { kind: 'medication', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 40, doseUnit: 'mg' };
const badEscalation = { kind: 'medication', medicationKey: 'statin_escalation', drugName: 42, doseValue: null, doseUnit: null };
const badField = { kind: 'field', field: 'ldlC', displayValue: '3.4', unitSystem: 'si', date: null };
const badProfile = { kind: 'profile', sex: 'other', heightCm: null };

const REPLIES: Array<[string, unknown]> = [
  ['readable', [field, statin]],
  ['malformed escalation beside a statin', [statin, badEscalation, field]],
  ['wrong-typed value', [badField, statin]],
  ['malformed profile', [field, badProfile]],
  ['both parts', [badField, badEscalation]],
  ['not a list', { kind: 'field' }],
];

function phoneRefusals(raw: unknown) {
  const file = newRecord(NOW, 'phone', 'en-NZ', 'Pacific/Auckland');
  const shown = JSON.parse(chatEditsJson(JSON.stringify(file), JSON.stringify(raw), NOW, 'phone', localDay(NOW))) as ChatEditsPreview;
  return [
    ...(shown.medications?.refusal ? [{ part: 'medications', words: shown.medications.refusal }] : []),
    ...(shown.review?.refusal ? [{ part: 'review', words: shown.review.refusal }] : []),
  ];
}

describe('US-67 AC2: web and iPhone refuse alike', () => {
  it.each(REPLIES)('%s', (_name, raw) => {
    expect(refuseUnreadableEdits(readProposedEdits(raw)).refusals).toEqual(phoneRefusals(raw));
  });
});
