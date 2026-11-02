// US-09 AC32b: test.html names the Dropbox folder the app really uses, the one
// a new connection gets (`DROPBOX_APP_FOLDER`), and the same one its round-trip
// result line names. Connections made before the rename keep the old folder,
// so the page names that one only as the older connections' folder.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DROPBOX_APP_FOLDER } from '../../packages/health-core/src/import-hints';

const read = (path: string) => readFileSync(resolve(__dirname, path), 'utf8');
/** What a reader sees: tags dropped, `&nbsp;` as a space, whitespace collapsed. */
const text = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
const OLD_FOLDER = 'Apps/Health Roadmap by Dr Brad';

const page = text(read('test.html'));
/** The Dropbox card: from its heading to the end of the page. */
const card = page.slice(page.indexOf('Dropbox live sync test'));

describe('US-09 AC32b: test.html names the Dropbox folder the app uses', () => {
  it('the Dropbox card names the folder a new connection gets', () => {
    expect(card.startsWith('Dropbox live sync test')).toBe(true);
    expect(card).toContain(`only /${DROPBOX_APP_FOLDER}/`);
  });

  it('it is the folder the round-trip result line names', () => {
    const resultLine = /`file: \/([^`$]+)\/\$\{SELF_TEST_DOC\.fileName\}/.exec(read('dropbox-test.ts'));
    expect(resultLine?.[1]).toBe(DROPBOX_APP_FOLDER);
    expect(card).toContain(`/${resultLine![1]}/`);
  });

  it('the pre-rename folder is named only as where older connections keep it', () => {
    expect(page.split(`/${OLD_FOLDER}/`)).toHaveLength(2);
    expect(card).toContain(`a connection made before the app was renamed keeps /${OLD_FOLDER}/`);
  });
});
