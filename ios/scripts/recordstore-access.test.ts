// PR 1384 split RecordStore.swift and widened these members from private to internal, since Swift
// private cannot cross files. This guard keeps every write to them inside RecordStore*.swift.
// Delete or narrow this test when the Source union PR restores private access.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

const APP = join(__dirname, '..', 'HealthRoadmap');
const MEMBERS = 'recordJSON|problem|cloudErase|cloudSession|cloudName|ownSaves|unitSwitches|shownOrder|histories|reading';
const WRITERS = 'display|show|forgetCharts|publish|draw|applyInCloud|shown|clearsChoices';
// The app names its RecordStore `store` (app.store, self.store); clearsChoices is static.
const WRITE = new RegExp(
  `\\bstore\\??\\.(?:(?:${MEMBERS})(?:\\[[^\\]]*\\])?\\s*(?:=(?!=)|\\+=|-=)|(?:${MEMBERS})\\.(?:append|insert|remove\\w*)\\(|(?:${WRITERS})\\()` +
    `|\\bRecordStore\\.clearsChoices\\(`,
);

it('only RecordStore*.swift writes the members PR 1384 widened', () => {
  const found = (readdirSync(APP, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.swift') && !/(^|\/)RecordStore[^/]*\.swift$/.test(f))
    .flatMap((f) => readFileSync(join(APP, f), 'utf8').split('\n')
      .flatMap((line, i) => (WRITE.test(line) ? [`${relative(join(APP, '..', '..'), join(APP, f))}:${i + 1}: ${line.trim()}`] : [])));
  expect(found, 'RecordStore members are internal only until the Source union PR; write them inside RecordStore*.swift.').toEqual([]);
});
