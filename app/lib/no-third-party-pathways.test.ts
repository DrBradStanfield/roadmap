/**
 * US-15 AC39 (2026-10-22, Brad, after Streamliners' IP complaint): no
 * third-party clinical pathway content is loaded, routed or stored. Every
 * surface (web chat, blog bubble, embed, Discord, YouTube, MCP search and the
 * router harness) reads the one index and the one loader checked here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { loadBlogIndex } from './blog-index.server';
import { loadBlogArticle, loadMatchedContent } from './matched-content';
import { routerIndexBlock, routerView } from './router-view';
import { buildSystemBlocks } from './chat.server';
import { ROUTER_VERSION, VALID_HANDLES } from './chat-router.server';

const ROOT = process.cwd();
const THIRD_PARTY = /healthpathways|auckland region|communityhealthpathways/i;
// Handles that were pathways before 2026-10-22, crisis and red-flag ones among them.
const FORMER_PATHWAYS = ['chest-pain', 'suicide-prevention-in-adults', 'stroke', 'pain-and-bleeding-in-early-pregnancy', 'febrile-illness-in-children'];

describe('US-15 AC39 — no third-party pathway content', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('the repo holds no docs/pathway and the index has no pathway entry', () => {
    expect(fs.existsSync(path.join(ROOT, 'docs/pathway'))).toBe(false);
    const index = loadBlogIndex();
    expect(index.length).toBeGreaterThan(300);
    expect(index.filter(e => (e.type as string | undefined) === 'pathway')).toEqual([]);
    for (const h of FORMER_PATHWAYS) expect(index.some(e => e.handle === h), h).toBe(false);
  });

  it('the index builder reads only docs/blog and docs/guideline', () => {
    const script = fs.readFileSync(path.join(ROOT, 'scripts/rebuild-blog-index.ts'), 'utf-8');
    expect(script).not.toContain("'docs/pathway'");
  });

  it('no knowledge file names HealthPathways as a source', () => {
    for (const dir of ['docs/blog', 'docs/guideline']) {
      for (const f of fs.readdirSync(path.join(ROOT, dir)).filter(n => n.endsWith('.md') || n.endsWith('.json'))) {
        expect(THIRD_PARTY.test(fs.readFileSync(path.join(ROOT, dir, f), 'utf-8')), `${dir}/${f}`).toBe(false);
      }
    }
  });

  it('a former pathway handle loads nothing and the loader never opens docs/pathway', () => {
    const read = vi.spyOn(fs, 'readFileSync');
    for (const h of FORMER_PATHWAYS) expect(loadBlogArticle(h), h).toBeNull();
    expect(loadMatchedContent(FORMER_PATHWAYS)).toEqual({ content: null, titles: [], skipped: [] });
    expect(read.mock.calls.filter(([p]) => String(p).includes('docs/pathway'))).toEqual([]);
  });

  it('the router can neither see nor return a pathway (ROUTER_VERSION 4)', () => {
    expect(ROUTER_VERSION).toBe(4);
    for (const h of FORMER_PATHWAYS) expect(VALID_HANDLES.has(h), h).toBe(false);
    expect(routerIndexBlock(routerView(loadBlogIndex()))).not.toMatch(/^\[pathway\]/m);
    const prompt = fs.readFileSync(path.join(ROOT, 'app/lib/chat-router-prompt.md'), 'utf-8');
    expect(prompt).not.toMatch(/pathway/i);
  });

  it('the answer prompt neither lists pathways nor cites HealthPathways', () => {
    const text = buildSystemBlocks('{}').map(b => b.text).join('\n');
    expect(text).not.toMatch(THIRD_PARTY);
    expect(text).not.toMatch(/clinical pathway/i);
  });
});
