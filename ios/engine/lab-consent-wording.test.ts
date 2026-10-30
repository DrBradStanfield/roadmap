// US-52 AC13e: the lab-upload consent screen says where the report goes. With
// Dropbox or Google Drive connected, the save files the original report in that
// cloud (AC13d, RecordStore.saveDocument -> documentSave), so "The report itself
// is not kept" was false. The reading screen already says "The server keeps no
// copy" (AC13c). Read from the Swift source, as chat-context-keys.test.ts reads
// ChatClient.swift; the screen itself is checked in the simulator.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const swift = readFileSync(join(__dirname, '../HealthRoadmap/Chat/AIConsent.swift'), 'utf8');
const keptWhere = swift.slice(swift.indexOf('private var keptWhere'), swift.indexOf('private func agree'));
const labLine = /case \.labUpload: "([^"]*)"/.exec(keptWhere)?.[1] ?? '';

describe('US-52 AC13e: the lab-upload consent says where the report is kept', () => {
  it('finds the lab-upload line', () => {
    expect(labLine).not.toBe('');
  });

  it('no longer says the report is not kept', () => {
    expect(labLine).not.toMatch(/not kept/i);
  });

  it("says Dr Brad's server keeps no copy, and that a connected Dropbox or Google Drive keeps the original", () => {
    expect(labLine).toContain("Dr Brad's server keeps no copy");
    expect(labLine).toMatch(/Dropbox or Google Drive/);
    expect(labLine).toMatch(/original/);
  });
});
