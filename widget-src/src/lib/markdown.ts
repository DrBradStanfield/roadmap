/**
 * Simple markdown → HTML renderer for health documents.
 * Handles: headers, bold, italic, lists, tables, line breaks.
 * No external dependencies.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderMarkdown(md: string): string {
  const lines = md.split('\n');
  const html: string[] = [];
  let inList = false;
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Table rows
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      // Skip separator rows (|---|---|)
      if (/^\|[\s\-:|]+\|$/.test(line.trim())) continue;

      if (!inTable) {
        if (inList) { html.push('</ul>'); inList = false; }
        html.push('<div class="md-table-wrap"><table class="md-table">');
        inTable = true;
      }
      const cells = line.trim().slice(1, -1).split('|').map(c => inlineFormat(escapeHtml(c.trim())));
      // First data row = header if table just started
      const tag = html[html.length - 1] === '<table class="md-table">' ? 'th' : 'td';
      html.push(`<tr>${cells.map(c => `<${tag}>${c}</${tag}>`).join('')}</tr>`);
      continue;
    } else if (inTable) {
      html.push('</table></div>');
      inTable = false;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headerMatch) {
      if (inList) { html.push('</ul>'); inList = false; }
      const level = headerMatch[1].length;
      html.push(`<h${level + 1}>${inlineFormat(escapeHtml(headerMatch[2]))}</h${level + 1}>`);
      continue;
    }

    // Unordered list items
    if (/^[\-\*]\s+/.test(line)) {
      if (!inList) { html.push('<ul>'); inList = true; }
      html.push(`<li>${inlineFormat(escapeHtml(line.replace(/^[\-\*]\s+/, '')))}</li>`);
      continue;
    } else if (inList) {
      html.push('</ul>');
      inList = false;
    }

    // Empty line
    if (line.trim() === '') {
      continue;
    }

    // Paragraph
    html.push(`<p>${inlineFormat(escapeHtml(line))}</p>`);
  }

  if (inList) html.push('</ul>');
  if (inTable) html.push('</table></div>');

  return html.join('\n');
}

/** Apply inline formatting: **bold**, *italic*, `code`, [links](url) */
function inlineFormat(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
      if (!/^https:\/\//i.test(url)) return text;
      return `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
    });
}
