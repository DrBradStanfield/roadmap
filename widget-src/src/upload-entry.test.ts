// @vitest-environment jsdom
/**
 * The upload bundle's job is to put its functions on window.HealthUpload, where
 * the main widget bundle (UploadModal) reads them.
 */
import { describe, expect, it } from 'vitest';
import * as entry from './upload-entry';

describe('upload-entry', () => {
  it('puts exactly the functions it exports on window.HealthUpload', () => {
    const published = window.HealthUpload as unknown as Record<string, unknown>;
    expect(Object.keys(published).sort()).toEqual(Object.keys(entry).sort());
    for (const [name, fn] of Object.entries(entry)) expect(published[name], name).toBe(fn);
  });
});
