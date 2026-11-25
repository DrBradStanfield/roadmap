// Lead I-7: pins for the CLI's one profile write (get-plan --from-values,
// `recordFromValues`), taken on main before `updateProfile` left mcp-tools.ts:
// the profile built in memory, and the refusal line for a value out of range.
import { describe, expect, it } from 'vitest';
import { recordFromValues } from './get-plan';

const NOW = new Date('2026-09-01T09:00:00.000Z');

describe('I-7 pins: get-plan --from-values profile', () => {
  it('builds the profile through the shared write', () => {
    const file = recordFromValues(JSON.stringify({ sex: 'female', birthYear: 1972, birthMonth: 4, heightCm: 165, values: [] }), NOW);
    expect({ profile: file.profile, meta: file.meta }).toMatchInlineSnapshot(`
      {
        "meta": {
          "createdAt": "2026-09-01T09:00:00.000Z",
          "lamport": 0,
          "lastDeviceId": "get-plan-values",
          "updatedAt": "2026-09-01T09:00:00.000Z",
        },
        "profile": {
          "birthMonth": 4,
          "birthYear": 1972,
          "fieldStamps": {
            "birthMonth": {
              "lamport": 1,
              "updatedAt": "2026-09-01T09:00:00.000Z",
            },
            "birthYear": {
              "lamport": 1,
              "updatedAt": "2026-09-01T09:00:00.000Z",
            },
            "heightCm": {
              "lamport": 1,
              "updatedAt": "2026-09-01T09:00:00.000Z",
            },
            "sex": {
              "lamport": 1,
              "updatedAt": "2026-09-01T09:00:00.000Z",
            },
          },
          "heightCm": 165,
          "lamport": 1,
          "sex": "female",
          "updatedAt": "2026-09-01T09:00:00.000Z",
        },
      }
    `);
  });

  it('refuses a height out of range with the write own words', () => {
    let thrown: unknown;
    try {
      recordFromValues(JSON.stringify({ sex: 'male', age: 50, heightCm: 20, values: [] }), NOW);
    } catch (error) {
      thrown = error;
    }
    expect({ message: (thrown as Error).message, hint: (thrown as { hint?: string }).hint }).toMatchInlineSnapshot(`
      {
        "hint": "Shape: {"sex":"male","age":52,"heightCm":178,"values":[{"metric":"ldl","value":3.2,"unit":"mmol/L"}]}. See --help.",
        "message": "heightCm: Height must be at least 50 cm. Nothing was written.",
      }
    `);
  });
});
