/** US-14 AC14 (and AC3): one rule decides which archived original opens in a preview, on the web and the iPhone. */
import { describe, expect, it } from 'vitest';
import { originalPreview, VIEWABLE_KINDS } from './file-kinds';

const open = (name: string, stored: string, served = '') => originalPreview(name, stored, served);

describe('US-14 AC14: originalPreview', () => {
  it('the table holds only the passive kinds, each type once', () => {
    expect(VIEWABLE_KINDS.map((k) => k.type)).toEqual(['application/pdf', 'image/png', 'image/jpeg', 'image/heic']);
  });

  it('a passive extension opens under its own name, typed by the table', () => {
    expect(open('Lab results/2024-06-01 Panel.pdf', 'application/pdf')).toEqual({ name: '2024-06-01 Panel.pdf', type: 'application/pdf' });
    expect(open('Scan.PNG', 'image/png')).toEqual({ name: 'Scan.PNG', type: 'image/png' });
    expect(open('Scan.jpg', 'image/jpeg')).toEqual({ name: 'Scan.jpg', type: 'image/jpeg' });
    expect(open('Scan.JPEG', 'IMAGE/JPEG; charset=binary')).toEqual({ name: 'Scan.JPEG', type: 'image/jpeg' });
    expect(open('Scan.heic', '')).toEqual({ name: 'Scan.heic', type: 'image/heic' });
    expect(open('Letter.pdf', 'application/octet-stream')).toEqual({ name: 'Letter.pdf', type: 'application/pdf' });
  });

  it('an active or unknown extension downloads, whatever type is stored', () => {
    for (const name of ['Chart.svg', 'Page.html', 'Data.xml', 'Letter.docx', 'Notes.txt', 'Scan.webp', 'Report.verylongext', 'Scan.png.svg', 'a.b-c']) {
      expect(open(name, 'application/pdf'), name).toBeNull();
      expect(open(name, ''), name).toBeNull();
    }
  });

  it('a stored or served type that is not the extension\'s own downloads', () => {
    expect(open('Scan.png', 'image/svg+xml')).toBeNull();
    expect(open('Letter.pdf', 'text/html')).toBeNull();
    expect(open('Letter.pdf', 'application/pdf', 'text/html')).toBeNull();
    expect(open('Scan.png', '', 'image/svg+xml')).toBeNull();
    expect(open('Letter.pdf', 'image/png')).toBeNull();
  });

  it('with no extension, a passive stored type opens under its kind\'s extension', () => {
    expect(open('Other documents/Scan', 'image/png')).toEqual({ name: 'Scan.png', type: 'image/png' });
    expect(open('Scan', 'image/jpeg')).toEqual({ name: 'Scan.jpeg', type: 'image/jpeg' });
    expect(open('Letter', ' Application/PDF ; name=x')).toEqual({ name: 'Letter.pdf', type: 'application/pdf' });
    expect(open('', 'image/heic')).toEqual({ name: 'document.heic', type: 'image/heic' });
    expect(open('Letter', 'application/pdf', 'application/octet-stream')).toEqual({ name: 'Letter.pdf', type: 'application/pdf' });
  });

  it('as iOS reads a name, a leading dot, an empty ending or one with a space is no extension', () => {
    expect(open('2026-09-14 Letter from Dr. Smith', 'application/pdf')).toEqual({ name: '2026-09-14 Letter from Dr. Smith.pdf', type: 'application/pdf' });
    expect(open('Letter.', 'image/png')).toEqual({ name: 'Letter..png', type: 'image/png' });
    expect(open('.pdf', 'image/png')).toEqual({ name: '.pdf.png', type: 'image/png' });
    expect(open('Dr. Smith', '')).toBeNull();
    expect(open('Dr. Smith', 'image/svg+xml')).toBeNull();
  });

  it('with no extension, a scriptable, unknown, empty or untyped stored type downloads', () => {
    for (const stored of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/javascript', '', 'application/octet-stream']) {
      expect(open('Letter', stored), stored).toBeNull();
    }
    // The served type must agree with the stored one too.
    expect(open('Scan', 'image/png', 'image/svg+xml')).toBeNull();
  });

  it('only the exact type matches: aliases, prefixes and hostile strings download', () => {
    for (const stored of ['image/jpg', 'image/pjpeg', 'application/x-pdf', 'application/pdfx', 'application/pdf/x', 'image/png\u0000', 'image/png,text/html', 'image', 'application/', 'constructor', '__proto__', 'toString']) {
      expect(open('Letter', stored), stored).toBeNull();
      expect(open('Letter.pdf', stored), stored).toBeNull();
    }
    for (const name of ['Letter.constructor', 'Letter.__proto__', 'Letter.toString', 'Letter.hasOwnProperty']) {
      expect(open(name, 'application/pdf'), name).toBeNull();
    }
  });
});

// The web's AC3 cases, moved here with the rule: the bytes as the cloud served them, no stored type.
describe('US-14 AC3: the served type', () => {
  const served = (fileRef: string, type: string) => originalPreview(fileRef, '', type)?.type ?? null;
  it('opens a passive type when the ref and the served bytes agree, or the bytes come untyped (Dropbox, GitHub)', () => {
    expect(served('Lab reports/2024-06-01 Panel.pdf', 'application/pdf')).toBe('application/pdf');
    expect(served('Other documents/2024-06-01 Scan.PNG', 'image/png')).toBe('image/png');
    expect(served('Other documents/2024-06-01 Scan.jpeg', 'image/jpeg; charset=binary')).toBe('image/jpeg');
    expect(served('Other documents/2024-06-01 Scan.heic', 'image/heic')).toBe('image/heic');
    expect(served('Lab reports/2024-06-01 Panel.pdf', '')).toBe('application/pdf');
    expect(served('Lab reports/2024-06-01 Panel.pdf', 'application/octet-stream')).toBe('application/pdf');
  });
  it('downloads anything else: an active type, a mismatch, an unknown or missing extension', () => {
    expect(served('Other documents/2024-06-01 Chart.svg', 'image/svg+xml')).toBeNull();
    expect(served('Other documents/2024-06-01 Scan.png', 'image/svg+xml')).toBeNull();
    expect(served('Lab reports/2024-06-01 Panel.pdf', 'text/html')).toBeNull();
    expect(served('Other documents/2024-06-01 Page.html', 'text/html')).toBeNull();
    expect(served('Other documents/2024-06-01 Letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBeNull();
    expect(served('Other documents/2024-06-01 Letter', '')).toBeNull();
  });
});
