// Lead I-7: pins for the iPhone engine's profile writes (my-data.ts `profile`,
// chat-edits.ts's profile part), taken on main before `updateProfile` left
// mcp-tools.ts. They go through the engine's own doors only, so the move cannot
// edit them: the resulting profile and meta, and each refusal's words.
import { describe, expect, it } from 'vitest';
import { applyEdit, newRecord } from './my-data';
import { parseProposedEdit } from '../../packages/health-core/src/chat-edits';
import { localDay } from '../../packages/health-core/src/merge';
import type { RoadmapFile } from '../../packages/health-core/src/roadmap-file';

const MADE = '2026-11-01T08:00:00.000Z';
const NOW = '2026-11-02T08:00:00.000Z';

const metric = () => newRecord(MADE, 'phone', 'en-NZ', 'Pacific/Auckland');
const us = () => newRecord(MADE, 'phone', 'en-US', 'America/New_York');
const written = (outcome: ReturnType<typeof applyEdit>): RoadmapFile => {
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.file;
};

describe('I-7 pins: My data profile edit', () => {
  it('writes sex, birth year and month, and height in the record units, stamping only those fields', () => {
    const before = metric();
    const after = written(applyEdit(before, { kind: 'profile', sex: 'female', birthYear: 1980, birthMonth: 3, height: 165 }, NOW));
    expect({ profile: after.profile, meta: after.meta }).toMatchInlineSnapshot(`
      {
        "meta": {
          "createdAt": "2026-11-01T08:00:00.000Z",
          "lamport": 0,
          "lastDeviceId": "phone",
          "updatedAt": "2026-11-02T08:00:00.000Z",
        },
        "profile": {
          "birthMonth": 3,
          "birthYear": 1980,
          "fieldStamps": {
            "birthMonth": {
              "lamport": 1,
              "updatedAt": "2026-11-02T08:00:00.000Z",
            },
            "birthYear": {
              "lamport": 1,
              "updatedAt": "2026-11-02T08:00:00.000Z",
            },
            "heightCm": {
              "lamport": 1,
              "updatedAt": "2026-11-02T08:00:00.000Z",
            },
            "sex": {
              "lamport": 1,
              "updatedAt": "2026-11-02T08:00:00.000Z",
            },
            "unitSystem": {
              "lamport": 0,
              "updatedAt": "2026-11-01T08:00:00.000Z",
            },
          },
          "heightCm": 165,
          "lamport": 1,
          "sex": "female",
          "unitSystem": "si",
          "updatedAt": "2026-11-02T08:00:00.000Z",
        },
      }
    `);
    expect({ ...after, profile: before.profile, meta: before.meta }).toEqual(before);
  });

  it('reads height in inches in a US record, and feet and inches by the web rule', () => {
    expect(written(applyEdit(us(), { kind: 'profile', height: 70 }, NOW)).profile.heightCm).toMatchInlineSnapshot(`177.8`);
    expect(written(applyEdit(us(), { kind: 'profile', heightFeet: 5, heightInches: 11 }, NOW)).profile.heightCm).toMatchInlineSnapshot(`180.34`);
  });

  it('each refusal, in the person words', () => {
    expect(applyEdit(metric(), { kind: 'profile', height: 20 }, NOW)).toMatchInlineSnapshot(`
      {
        "message": "Height must be at least 50 cm.",
        "ok": false,
        "reason": "invalid-value",
      }
    `);
    expect(applyEdit(metric(), { kind: 'profile', birthYear: 1800 }, NOW)).toMatchInlineSnapshot(`
      {
        "message": "Birth year must be after 1900.",
        "ok": false,
        "reason": "invalid-value",
      }
    `);
    expect(applyEdit(metric(), { kind: 'profile', birthYear: 2026, birthMonth: 12 }, NOW)).toMatchInlineSnapshot(`
      {
        "message": "Your birth month cannot be in the future.",
        "ok": false,
        "reason": "invalid-value",
      }
    `);
    expect(applyEdit(metric(), { kind: 'profile' }, NOW)).toMatchInlineSnapshot(`
      {
        "message": "Name at least one of sex, birthYear, birthMonth, heightCm. Nothing was written.",
        "ok": false,
        "reason": "invalid-value",
      }
    `);
  });

  it('a value already held writes nothing', () => {
    const file = written(applyEdit(metric(), { kind: 'profile', sex: 'male' }, NOW));
    expect(written(applyEdit(file, { kind: 'profile', sex: 'male' }, NOW))).toBe(file);
  });
});

describe('I-7 pins: chat profile edit', () => {
  const profile = (input: object) => parseProposedEdit('propose_profile_edit', input)!;
  const chat = (file: RoadmapFile, edits: unknown) => applyEdit(file, { kind: 'chatEdits', part: 'review', edits, today: localDay(NOW) }, NOW);

  it('writes the stated sex and height, and refuses one out of range', () => {
    const after = written(chat(metric(), [profile({ sex: 'male', height: { value: 180, unit: 'cm' } })]));
    expect(after.profile).toMatchInlineSnapshot(`
      {
        "fieldStamps": {
          "heightCm": {
            "lamport": 1,
            "updatedAt": "2026-11-02T08:00:00.000Z",
          },
          "sex": {
            "lamport": 1,
            "updatedAt": "2026-11-02T08:00:00.000Z",
          },
          "unitSystem": {
            "lamport": 0,
            "updatedAt": "2026-11-01T08:00:00.000Z",
          },
        },
        "heightCm": 180,
        "lamport": 1,
        "sex": "male",
        "unitSystem": "si",
        "updatedAt": "2026-11-02T08:00:00.000Z",
      }
    `);
    // The shape the server sends for a height out of range: updateProfile refuses it.
    expect(chat(metric(), [{ kind: 'profile', sex: null, heightCm: 400 }])).toMatchInlineSnapshot(`
      {
        "message": "Your height is outside what the record accepts. Nothing was saved.",
        "ok": false,
        "reason": "chat-refused",
      }
    `);
  });

  it('a null entry (a proposal the server parser dropped) is skipped', () => {
    const file = metric();
    const skipped = chat(file, [null]);
    expect(skipped.ok && skipped.file).toBe(file);
  });
});
