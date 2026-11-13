/**
 * Lead I-7: pins for the profile write, through every caller in health-core,
 * taken on main BEFORE `updateProfile` left mcp-tools.ts. They import only the
 * callers (`callTool`, `runToolOverSync`, `toolContent`) and the published tool
 * list, never the function itself, so the move cannot edit them.
 *
 * Pinned: the resulting file byte for byte (which profile fields change, their
 * stamps, `meta.updatedAt`, `eraseEpoch` untouched, unknown keys kept), every
 * refusal's text and reason, heightCm read as cm whatever the record's units,
 * the tool's result payload, and the agent-facing tool entry.
 *
 * Test-only. Synthetic records, no network.
 */
import { describe, expect, it } from 'vitest';
import { ROADMAP_FILE_NAME } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { MCP_TOOLS } from './mcp-tool-catalogue';
import { callTool, runToolOverSync, toolContent } from './mcp-tools';
import { recordSync } from './roadmap-doc';
import { createEmptyFile, type RoadmapFile } from './roadmap-file';

const READ_AT = '2026-09-01T08:00:00.000Z';
const NOW = '2026-09-01T09:00:00.000Z';

/** A record at erase counter 2, its profile written once, holding a key this version does not know. */
function record(unitSystem: 'si' | 'conventional' = 'si'): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'synthetic', now: READ_AT });
  file.meta = { ...file.meta, eraseEpoch: 2, erasedAt: '2026-01-01T00:00:00.000Z' };
  Object.assign(file.profile, { sex: 'male', birthYear: 1971, heightCm: 178, unitSystem, futureField: 'kept' });
  return file;
}

const call = (args: unknown, file = record()) => callTool('update_profile', args, { file, now: NOW });

describe('I-7 pins: callTool update_profile, the resulting file', () => {
  it('stamps only the changed fields, moves meta.updatedAt, keeps eraseEpoch and unknown keys', () => {
    const before = record();
    const outcome = call({ heightCm: 181, birthMonth: 4, sex: 'male' }, before);
    expect(outcome.status).toBe('ok');
    const after = (outcome as { file: RoadmapFile }).file;
    expect(after.profile).toMatchInlineSnapshot(`
      {
        "birthMonth": 4,
        "birthYear": 1971,
        "fieldStamps": {
          "birthMonth": {
            "lamport": 1,
            "updatedAt": "2026-09-01T09:00:00.000Z",
          },
          "birthYear": {
            "lamport": 0,
            "updatedAt": "2026-09-01T08:00:00.000Z",
          },
          "futureField": {
            "lamport": 0,
            "updatedAt": "2026-09-01T08:00:00.000Z",
          },
          "heightCm": {
            "lamport": 1,
            "updatedAt": "2026-09-01T09:00:00.000Z",
          },
          "sex": {
            "lamport": 0,
            "updatedAt": "2026-09-01T08:00:00.000Z",
          },
          "unitSystem": {
            "lamport": 0,
            "updatedAt": "2026-09-01T08:00:00.000Z",
          },
        },
        "futureField": "kept",
        "heightCm": 181,
        "lamport": 1,
        "sex": "male",
        "unitSystem": "si",
        "updatedAt": "2026-09-01T09:00:00.000Z",
      }
    `);
    expect(after.meta).toMatchInlineSnapshot(`
      {
        "createdAt": "2026-09-01T08:00:00.000Z",
        "eraseEpoch": 2,
        "erasedAt": "2026-01-01T00:00:00.000Z",
        "lamport": 0,
        "lastDeviceId": "synthetic",
        "updatedAt": "2026-09-01T09:00:00.000Z",
      }
    `);
    // Nothing else in the file moves.
    expect({ ...after, profile: before.profile, meta: before.meta }).toEqual(before);
    expect(before.profile.heightCm).toBe(178);
    expect(outcome.text).toMatchInlineSnapshot(`
      "birthMonth: not set → 4
      heightCm: 178 → 181"
    `);
    expect((outcome as { data: unknown }).data).toMatchInlineSnapshot(`
      {
        "changed": [
          {
            "field": "birthMonth",
            "from": null,
            "to": 4,
          },
          {
            "field": "heightCm",
            "from": 178,
            "to": 181,
          },
        ],
      }
    `);
  });

  it('reads heightCm as cm in a US-units record', () => {
    const outcome = call({ heightCm: 170 }, record('conventional'));
    expect((outcome as { file: RoadmapFile }).file.profile.heightCm).toBe(170);
    expect(outcome.text).toMatchInlineSnapshot(`"heightCm: 178 → 170"`);
  });

  it('a stored value this build cannot read is never echoed', () => {
    const file = record();
    (file.profile as unknown as Record<string, unknown>).heightCm = 'tall';
    const outcome = call({ heightCm: 180 }, file);
    expect(outcome.text).toMatchInlineSnapshot(`"heightCm: a value this app cannot read → 180"`);
    expect((outcome as { data: unknown }).data).toMatchInlineSnapshot(`
      {
        "changed": [
          {
            "field": "heightCm",
            "from": null,
            "to": 180,
          },
        ],
      }
    `);
  });

  it('a value already held writes nothing', () => {
    expect(call({ sex: 'male', heightCm: 178 })).toMatchInlineSnapshot(`
      {
        "data": {
          "changed": [],
        },
        "status": "ok",
        "text": "The record already says that. Nothing was written.",
      }
    `);
  });

  it('every refusal, its text, message and reason', () => {
    expect(call({})).toMatchInlineSnapshot(`
      {
        "status": "rejected",
        "text": "Name at least one of sex, birthYear, birthMonth, heightCm. Nothing was written.",
      }
    `);
    expect(call({ heightCm: 180, expected: { heightCm: 170 } })).toMatchInlineSnapshot(`
      {
        "status": "rejected",
        "text": "The record does not hold the heightCm you expected. Read the record, then update. Nothing was written.",
      }
    `);
    expect(call({ heightCm: 180, expected: { heightCm: null } })).toMatchInlineSnapshot(`
      {
        "status": "rejected",
        "text": "The record does not hold the heightCm you expected. Read the record, then update. Nothing was written.",
      }
    `);
    expect(call({ heightCm: 20 })).toMatchInlineSnapshot(`
      {
        "message": "Height must be at least 50 cm.",
        "status": "rejected",
        "text": "heightCm: Height must be at least 50 cm. Nothing was written.",
      }
    `);
    expect(call({ heightCm: 400 })).toMatchInlineSnapshot(`
      {
        "message": "Height must be at most 250 cm.",
        "status": "rejected",
        "text": "heightCm: Height must be at most 250 cm. Nothing was written.",
      }
    `);
    expect(call({ birthYear: 1800 })).toMatchInlineSnapshot(`
      {
        "message": "Birth year must be after 1900.",
        "status": "rejected",
        "text": "birthYear: Birth year must be after 1900. Nothing was written.",
      }
    `);
    expect(call({ birthMonth: 13 })).toMatchInlineSnapshot(`
      {
        "message": "Month must be between 1 and 12.",
        "status": "rejected",
        "text": "birthMonth: Month must be between 1 and 12. Nothing was written.",
      }
    `);
    expect(call({ birthYear: 2026, birthMonth: 10 })).toMatchInlineSnapshot(`
      {
        "message": "Your birth month cannot be in the future.",
        "status": "rejected",
        "text": "birthMonth: Your birth month cannot be in the future. Nothing was written.",
      }
    `);
    expect(call({ heightCm: 180, shoeSize: 9 })).toMatchInlineSnapshot(`
      {
        "status": "invalid-args",
        "text": "update_profile: Unrecognized key(s) in object: 'shoeSize'",
      }
    `);
    expect(call({ sex: 'other' })).toMatchInlineSnapshot(`
      {
        "status": "invalid-args",
        "text": "update_profile: sex — Invalid enum value. Expected 'male' | 'female', received 'other'",
      }
    `);
    expect(callTool('update_profile', { heightCm: 180 }, { file: undefined, now: NOW })).toMatchInlineSnapshot(`
      {
        "status": "rejected",
        "text": "update_profile needs the health record, and none is open. Check the file path the server was given.",
      }
    `);
  });
});

describe('I-7 pins: runToolOverSync update_profile, the saved file and the answer', () => {
  function over(file: RoadmapFile) {
    const cloud = new MemoryCloud();
    cloud.files.set(ROADMAP_FILE_NAME, { json: JSON.stringify(file), version: 1 });
    return { cloud, sync: recordSync(new MemoryAdapter(cloud), 'pin-device', NOW) };
  }
  const saved = (cloud: MemoryCloud) => JSON.parse(cloud.files.get(ROADMAP_FILE_NAME)!.json) as RoadmapFile;

  it('a change: the answer, its MCP payload and the file saved', async () => {
    const { cloud, sync } = over(record());
    const answer = await runToolOverSync(sync, 'update_profile', { heightCm: 181, expected: { heightCm: 178 } }, NOW, {
      savedNote: (warning) => `Saved.${warning ? ` ${warning}` : ''}`,
    });
    expect(answer).toMatchInlineSnapshot(`
      {
        "isError": false,
        "structured": {
          "changed": [
            {
              "field": "heightCm",
              "from": 178,
              "to": 181,
            },
          ],
        },
        "text": "heightCm: 178 → 181
      Saved.",
      }
    `);
    expect(toolContent(answer)).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "heightCm: 178 → 181
      Saved.",
            "type": "text",
          },
        ],
        "structuredContent": {
          "changed": [
            {
              "field": "heightCm",
              "from": 178,
              "to": 181,
            },
          ],
        },
      }
    `);
    const file = saved(cloud);
    expect(file.profile).toMatchInlineSnapshot(`
      {
        "birthYear": 1971,
        "fieldStamps": {
          "birthYear": {
            "lamport": 0,
            "updatedAt": "2026-09-01T08:00:00.000Z",
          },
          "futureField": {
            "lamport": 0,
            "updatedAt": "2026-09-01T08:00:00.000Z",
          },
          "heightCm": {
            "lamport": 1,
            "updatedAt": "2026-09-01T09:00:00.000Z",
          },
          "sex": {
            "lamport": 0,
            "updatedAt": "2026-09-01T08:00:00.000Z",
          },
          "unitSystem": {
            "lamport": 0,
            "updatedAt": "2026-09-01T08:00:00.000Z",
          },
        },
        "futureField": "kept",
        "heightCm": 181,
        "lamport": 1,
        "sex": "male",
        "unitSystem": "si",
        "updatedAt": "2026-09-01T09:00:00.000Z",
      }
    `);
    expect(file.meta.eraseEpoch).toBe(2);
    expect(file.meta.updatedAt).toBe(NOW);
  });

  it('a refusal and a no-op save nothing; a dry run says so', async () => {
    const { cloud, sync } = over(record());
    const refused = await runToolOverSync(sync, 'update_profile', { heightCm: 20 }, NOW, { latestDay: '2026-09-02' });
    expect(refused).toMatchInlineSnapshot(`
      {
        "isError": true,
        "reason": "other",
        "text": "heightCm: Height must be at least 50 cm. Nothing was written.",
      }
    `);
    expect(toolContent(refused)).toMatchInlineSnapshot(`
      {
        "content": [
          {
            "text": "heightCm: Height must be at least 50 cm. Nothing was written.",
            "type": "text",
          },
        ],
        "isError": true,
      }
    `);
    expect(await runToolOverSync(sync, 'update_profile', { heightCm: 178 }, NOW)).toMatchInlineSnapshot(`
      {
        "isError": false,
        "structured": {
          "changed": [],
        },
        "text": "The record already says that. Nothing was written.",
      }
    `);
    expect(await runToolOverSync(sync, 'update_profile', { heightCm: 181 }, NOW, { dryRun: true })).toMatchInlineSnapshot(`
      {
        "isError": false,
        "pendingWrite": true,
        "structured": {
          "changed": [
            {
              "field": "heightCm",
              "from": 178,
              "to": 181,
            },
          ],
        },
        "text": "heightCm: 178 → 181
      (Row ids are assigned when it is written.)",
      }
    `);
    expect(cloud.files.get(ROADMAP_FILE_NAME)!.version).toBe(1);
  });
});

describe('I-7 pins: the agent-facing tool entry', () => {
  it('update_profile as published, byte for byte', () => {
    expect(JSON.stringify(MCP_TOOLS.find((t) => t.name === 'update_profile'), null, 2)).toMatchInlineSnapshot(`
      "{
        "name": "update_profile",
        "cost": "correct",
        "_meta": {
          "openai/toolInvocation/invoking": "Updating your profile…",
          "openai/toolInvocation/invoked": "Updated your profile"
        },
        "title": "Change the profile the plan is computed from",
        "description": "Change who the record is about: sex, birth year, birth month, height in cm. Every suggestion is derived from them, so a wrong one makes the whole plan wrong. Setting a field the record does not hold yet is an add: send it on its own. CHANGING one the record already holds needs \`expected\` with the value you believe is there now, read from the record first — a mismatch refuses the call and writes nothing. This overwrites: the profile is one last-write-wins object with no earlier version to read back. Display preferences (units) are not yours to change. On the hosted server this takes two calls: the first answers with what it would do and a \`confirm\` receipt; show it to the user and call again with \`confirm\` and \`approval\` (the user’s own words, quoted verbatim) only after their own yes, in their own words.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "sex": {
              "type": "string",
              "enum": [
                "male",
                "female"
              ],
              "description": "The sex the plan is computed for."
            },
            "birthYear": {
              "type": "integer",
              "description": "Year of birth, e.g. 1971."
            },
            "birthMonth": {
              "type": "integer",
              "description": "Month of birth, 1–12."
            },
            "heightCm": {
              "type": "number",
              "description": "Height in centimetres."
            },
            "expected": {
              "type": "object",
              "description": "What you believe the record holds now, per field you are changing. \`null\` claims the field is unset.",
              "properties": {
                "sex": {
                  "type": [
                    "string",
                    "null"
                  ],
                  "enum": [
                    "male",
                    "female",
                    null
                  ]
                },
                "birthYear": {
                  "type": [
                    "integer",
                    "null"
                  ]
                },
                "birthMonth": {
                  "type": [
                    "integer",
                    "null"
                  ]
                },
                "heightCm": {
                  "type": [
                    "number",
                    "null"
                  ]
                }
              },
              "additionalProperties": false
            },
            "confirm": {
              "type": "string",
              "maxLength": 64,
              "description": "Hosted server, second call only: the receipt the first call returned, after the user’s own yes."
            },
            "approval": {
              "type": "string",
              "maxLength": 200
            }
          },
          "additionalProperties": false
        },
        "outputSchema": {
          "type": "object",
          "properties": {
            "changed": {
              "type": "array",
              "description": "Every field that moved. Empty when the record already said that.",
              "items": {
                "type": "object",
                "properties": {
                  "field": {
                    "type": "string",
                    "enum": [
                      "sex",
                      "birthYear",
                      "birthMonth",
                      "heightCm"
                    ]
                  },
                  "from": {
                    "type": [
                      "string",
                      "number",
                      "null"
                    ],
                    "description": "What the record held. \`null\` if unset."
                  },
                  "to": {
                    "type": [
                      "string",
                      "number"
                    ],
                    "description": "What it holds now."
                  }
                },
                "required": [
                  "field",
                  "from",
                  "to"
                ],
                "additionalProperties": false
              }
            },
            "proposal": {
              "type": "boolean",
              "description": "True on the first call of a two-phase write: nothing was written yet."
            },
            "confirm": {
              "type": "string",
              "description": "The receipt to send back, unchanged, after the user’s own yes."
            },
            "confirmFrom": {
              "type": "string",
              "description": "When the receipt becomes usable. Do not call before it."
            }
          },
          "required": [
            "changed"
          ],
          "additionalProperties": false
        },
        "annotations": {
          "readOnlyHint": false,
          "destructiveHint": true,
          "idempotentHint": true,
          "openWorldHint": false
        },
        "twoPhase": true
      }"
    `);
  });
});
