import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders headers', () => {
    expect(renderMarkdown('## Title')).toContain('<h3>Title</h3>');
    expect(renderMarkdown('### Subtitle')).toContain('<h4>Subtitle</h4>');
  });

  it('renders bold text', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
  });

  it('renders italic text', () => {
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>');
  });

  it('renders unordered lists', () => {
    const result = renderMarkdown('- item 1\n- item 2');
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>item 1</li>');
    expect(result).toContain('<li>item 2</li>');
  });

  it('renders tables', () => {
    const input = '| Name | Value |\n|------|-------|\n| LDL | 2.8 |';
    const result = renderMarkdown(input);
    expect(result).toContain('<table');
    expect(result).toContain('<th>Name</th>');
    expect(result).toContain('<td>2.8</td>');
  });

  it('escapes HTML entities', () => {
    const result = renderMarkdown('Value < 5 & > 3');
    expect(result).toContain('&lt;');
    expect(result).toContain('&amp;');
    expect(result).toContain('&gt;');
  });

  it('renders paragraphs for plain text', () => {
    expect(renderMarkdown('Hello world')).toContain('<p>Hello world</p>');
  });

  it('handles empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('handles deeply nested lists without crashing', () => {
    const input = '- level 1\n  - level 2\n    - level 3\n      - level 4';
    const result = renderMarkdown(input);
    expect(result).toContain('<ul>');
    expect(result).toContain('level 1');
  });

  it('handles unclosed bold markers', () => {
    const result = renderMarkdown('**unclosed bold');
    expect(typeof result).toBe('string');
  });

  it('handles very long input without crashing', () => {
    const input = 'Line\n'.repeat(5000);
    const result = renderMarkdown(input);
    expect(result.length).toBeGreaterThan(0);
  });

  it('escapes script tags in input', () => {
    const result = renderMarkdown('<script>alert("xss")</script>');
    expect(result).not.toContain('<script>');
    expect(result).toContain('&lt;script&gt;');
  });
});
