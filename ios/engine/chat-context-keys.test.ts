// Codex R3 (US-25 AC18, US-52 AC5): the app sends only an allow-list of the chat
// context's top-level keys (ChatClient.contextKeys in Swift). This test fails if
// health-core's chatContextOf can produce a key the list lacks, or the list names one
// it cannot produce, so the allow-list never silently drops real data or lets extra through.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parityFixtures } from './fixtures.mjs';
import { chatContextJson } from './app-doors';

const swift = readFileSync(join(__dirname, '../HealthRoadmap/Chat/ChatClient.swift'), 'utf8');
const block = swift.slice(swift.indexOf('static let contextKeys'), swift.indexOf(']', swift.indexOf('static let contextKeys')));
const allowed = new Set([...block.matchAll(/"(\w+)"/g)].map((m) => m[1]));

/** HealthInputs' fields, read from types.ts, plus chatContextOf's own four keys. */
function producible(): Set<string> {
  const types = readFileSync(join(__dirname, '../../packages/health-core/src/types.ts'), 'utf8');
  const body = types.slice(types.indexOf('export interface HealthInputs {'));
  const fields = [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  const chat = readFileSync(join(__dirname, '../../packages/health-core/src/chat-context.ts'), 'utf8');
  const own = chat.slice(chat.indexOf('export type ChatContextPayload'));
  const extras = [...own.slice(0, own.indexOf('};')).matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
  return new Set([...fields, ...extras]);
}

describe('chat context allow-list (Codex R3)', () => {
  it('is exactly the keys chatContextOf can produce', () => {
    expect(allowed.size).toBe(23);
    expect([...allowed].sort()).toEqual([...producible()].sort());
  });

  it('covers every key the engine sends for the parity records', () => {
    const sample = JSON.parse(readFileSync(join(__dirname, '../../docs/examples/health-roadmap.sample.json'), 'utf8'));
    for (const [name, record] of Object.entries(parityFixtures(sample))) {
      const keys = Object.keys(JSON.parse(chatContextJson(JSON.stringify(record), '2026-10-21T12:30:00.000Z', 'ios-test')));
      expect(keys.filter((key) => !allowed.has(key)), name).toEqual([]);
    }
  });
});
