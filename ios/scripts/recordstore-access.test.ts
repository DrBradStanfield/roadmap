// US-25 AC11 (the cloud source): PR 1384 split RecordStore.swift and widened these members from
// private to internal, since Swift private cannot cross files. This guard keeps every write to them,
// and any use of the ones that were fully private, inside MyData/RecordStore*.swift.
// Delete or narrow this test when the Source union PR restores private access.
// Limits: a regex, not a parser. An assignment split over more than two lines, or a store reached
// through a receiver not named `...store`/`...Store` or `$N`, is not seen.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const APP = join(__dirname, '..', 'HealthRoadmap');
const MEMBERS = '(?:recordJSON|problem|cloudErase|cloudSession|cloudName|ownSaves|unitSwitches|shownOrder|histories|reading)';
const WRITERS = '(?:display|show|forgetCharts|publish|draw|applyInCloud|shown|clearsChoices)';
const PRIVATE = '(?:cloudSession|shownOrder|histories|reading)'; // fully private before PR 1384: any use is new
const STORE = '\\b\\w*[sS]tore[?!]?\\.'; // app.store, recordStore, store!, RecordStore (static)
const RECV = `(?:${STORE}|\\$\\d+[?!]?\\.)`; // $0 only for member writes: OnboardingView's $0.show( is not ours
const SUB = '(?:\\[[^\\n]*?\\])?(?:\\??\\.\\w+)*'; // [k], [a[b]], ?.chart
const ASSIGN = '\\s*[-+*]?=(?!=)';
const MUTATE = '\\??\\.(?:append|insert|remove\\w*|updateValue|merge)\\(';
const tuple = (recv: string) => `\\(\\s*[^()=]*${recv}${MEMBERS}\\b[^()=]*\\)${ASSIGN}`;
const ANY = new RegExp([
  `${RECV}${MEMBERS}\\b${SUB}(?:${ASSIGN}|${MUTATE})`,
  `${STORE}${WRITERS}\\(`,
  tuple(RECV),
  `\\\\(?:RecordStore)?\\.${MEMBERS}\\b`, // keypaths
  `${RECV}${PRIVATE}\\b`,
  '\\b(?:Stamp|KeptHistory)\\b',
].join('|'));
// Inside `extension RecordStore` a write needs no receiver (R2). A let/var/case tuple is a binding.
const IN_EXTENSION = new RegExp(`^\\s*(?:self\\.)?${MEMBERS}\\b${SUB}${ASSIGN}|^(?!.*\\b(?:let|var|case)\\s*\\().*${tuple('(?:self\\.)?\\b')}`);

it('only MyData/RecordStore*.swift writes the members PR 1384 widened', () => {
  const found = (readdirSync(APP, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.swift') && !/^MyData\/RecordStore[^/]*\.swift$/.test(f))
    .flatMap((f) => {
      const text = readFileSync(join(APP, f), 'utf8');
      const hit = (s: string) => ANY.test(s) || (/\bextension RecordStore\b/.test(text) && IN_EXTENSION.test(s));
      const lines = text.split('\n');
      // A line that matches only when joined with the next one: an assignment split over two lines.
      return lines.flatMap((line, i) => {
        const next = lines[i + 1] ?? '';
        return hit(line) || (!hit(next) && hit(`${line} ${next.trim()}`)) ? [`ios/HealthRoadmap/${f}:${i + 1}: ${line.trim()}`] : [];
      });
    });
  expect(found, 'RecordStore members are internal only until the Source union PR; write them inside RecordStore*.swift.').toEqual([]);
});
