// US-25 AC11 (the cloud source): PR 1384 split RecordStore.swift and widened members from private to
// internal, since Swift private cannot cross files. The Source union PR (US-25 AC11o) took back what it
// could: `source`, `recordJSON` and `problem` are private(set) and `cloudErase` is get-only, so the
// compiler guards them; `show`, `applyInCloud` and `shownOrder` are private; cloudSession, cloudName,
// cloudAccount and marksPending are gone. What is still internal, because RecordStore+*.swift writes or
// calls it, is guarded here: no write to those members and no call to those writers outside
// MyData/RecordStore*.swift, and the source's one public door, `link`, only from Sync/CloudSync.swift.
// Limits: a regex, not a parser. An assignment split over more than two lines, or a store reached
// through a receiver not named `...store`/`...Store` or `$N`, is not seen.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const APP = join(__dirname, '..', 'HealthRoadmap');
const MEMBERS = '(?:ownSaves|unitSwitches|histories|reading)';
const WRITERS = '(?:display|publish|draw|shown|forgetCharts|clearsChoices|commitPhoneDocument|applyInTurn)';
const PRIVATE = '(?:histories|reading)'; // fully private before PR 1384: any use is new
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
const LINK = new RegExp(`${STORE}link\\(`);

const swiftFiles = () => (readdirSync(APP, { recursive: true }) as string[]).filter((f) => f.endsWith('.swift'));

/** Each line of `f` that `hit` matches, alone or joined with the next one (an assignment split over two lines). */
const hits = (f: string, hit: (s: string, text: string) => boolean) => {
  const text = readFileSync(join(APP, f), 'utf8');
  const lines = text.split('\n');
  return lines.flatMap((line, i) => {
    const next = lines[i + 1] ?? '';
    const is = (s: string) => hit(s, text);
    return is(line) || (!is(next) && is(`${line} ${next.trim()}`)) ? [`ios/HealthRoadmap/${f}:${i + 1}: ${line.trim()}`] : [];
  });
};

it('only MyData/RecordStore*.swift writes the members PR 1384 widened and still internal', () => {
  const found = swiftFiles()
    .filter((f) => !/^MyData\/RecordStore[^/]*\.swift$/.test(f))
    .flatMap((f) => hits(f, (s, text) => ANY.test(s) || (/\bextension RecordStore\b/.test(text) && IN_EXTENSION.test(s))));
  expect(found, 'These RecordStore members are internal only so RecordStore+*.swift can reach them; write them inside RecordStore*.swift.').toEqual([]);
});

it('only CloudSync links the store (lead S23)', () => {
  const found = swiftFiles()
    .filter((f) => f !== 'Sync/CloudSync.swift' && !/^MyData\/RecordStore[^/]*\.swift$/.test(f))
    .flatMap((f) => hits(f, (s) => LINK.test(s)));
  expect(found, 'RecordStore.link is CloudSync\'s door to the source; nothing else sets the link.').toEqual([]);
});
