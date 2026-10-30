// US-52 AC13e: the lab-upload consent screen says where the report goes. When
// the record syncs with Dropbox or Google Drive, the save files a picked file's
// original in that cloud (AC13d, RecordStore.saveDocument -> documentSave), so
// "The report itself is not kept" was false. A photo or a scan carries no
// original, so the line speaks of a report picked from Files. The screen's
// third paragraph already says "Dr Brad's server keeps none of it", so this line
// does not say it again. Read from the Swift source, as chat-context-keys.test.ts
// reads ChatClient.swift; the screen itself is checked in the simulator.
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

  it('says a report picked from Files is also saved when the record syncs with Dropbox or Google Drive', () => {
    expect(labLine).toContain('If your record syncs with Dropbox or Google Drive, a report you pick from Files is also saved there.');
  });

  it("leaves the server's no-copy promise to the paragraph that already makes it", () => {
    expect(swift).toContain("Dr Brad's server keeps none of it.");
    expect(labLine).not.toMatch(/server/i);
  });
});
