// @vitest-environment jsdom
/**
 * Microsoft Clarity records page text by default, and the widget renders blood
 * results as page text. `data-clarity-mask="true"` masks the node and every
 * descendant and overrides the project-level masking mode
 * (learn.microsoft.com/clarity/setup-and-installation/clarity-masking).
 *
 * The widget root covers everything React renders in place. The surfaces that
 * portal to <body> escape that subtree, so each carries its own attribute.
 * Clicks and scrolls still record, so Clarity stays useful for UX.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { render } from '@testing-library/react';

vi.mock('../lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('../lib/chat-api', () => ({ getChatGate: () => null }));
vi.mock('./FeedbackForm', () => ({ FeedbackForm: () => null }));
vi.mock('./ChatKeyGate', () => ({ ChatKeyGate: () => null }));
vi.mock('./ChatMessageBubble', () => ({ ChatMessageBubble: () => null }));
vi.mock('./ChatThreadList', () => ({ ChatThreadList: () => null }));
vi.mock('./ChatHeaderTitle', () => ({ ChatHeaderTitle: () => null }));
vi.mock('../hooks/useChatState', () => ({
  MAX_CHARS: 2000,
  useChatState: () => ({
    state: {
      conversations: [], activeConversationId: null, messages: [], inputText: '',
      isLoading: false, replying: false, load: 'none', isLocalSender: false, error: null, isOffline: false,
      pending: { thinking: '', text: '', status: '', sources: [] }, approachById: {},
    },
    actions: {
      handleInputChange: vi.fn(), selectConversation: vi.fn(), startNewChat: vi.fn(),
      handleSend: vi.fn(), handleDelete: vi.fn(), loadConversationsIfNeeded: vi.fn(),
    },
    refs: { inputRef: { current: null }, messagesContainerRef: { current: null } },
  }),
}));

import { ChatSection } from './ChatSection';

const src = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('Clarity masking — health values never reach a session recording', () => {
  it('masks the chat, which portals to <body> when floating', () => {
    const collapsed = render(<ChatSection isLoggedIn />);
    expect(collapsed.container.querySelector('.chat-section')!
      .getAttribute('data-clarity-mask')).toBe('true');

    const expanded = render(<ChatSection isLoggedIn startExpanded />);
    expect(expanded.container.querySelector('.chat-section')!
      .getAttribute('data-clarity-mask')).toBe('true');
  });

  it('masks the widget root that the storefront theme mounts', () => {
    const liquid = src('../../../extensions/health-tool-widget/blocks/app-block.liquid');
    const rootTag = /<div\b[^>]*id="health-tool-root"[^>]*>/s.exec(liquid);
    expect(rootTag).not.toBeNull();
    expect(rootTag![0]).toContain('data-clarity-mask="true"');
  });

  it('US-74 AC5: masks the waist-to-height block\'s root, which the widget renders into', () => {
    const liquid = src('../../../extensions/health-tool-widget/blocks/waist-to-height.liquid');
    const rootTag = /<div\b[^>]*data-widget="waist-to-height"[^>]*>/s.exec(liquid);
    expect(rootTag).not.toBeNull();
    expect(rootTag![0]).toContain('data-clarity-mask="true"');
    expect(rootTag![0]).toContain('class="hr-widget"');
    // AC1: no hero, no doctor photo or name.
    expect(liquid).not.toMatch(/hr-hero|<img|Dr Brad|Stanfield/);
    // Review C9: the schema loads the bundle once per page; no script tag per block.
    const schema = JSON.parse(liquid.split('{% schema %}')[1].split('{% endschema %}')[0]);
    expect([schema.javascript, schema.stylesheet]).toEqual(['health-widgets.js', 'health-widgets.css']);
    expect(liquid).not.toMatch(/<script\s+src|asset_url|stylesheet_tag/);
    // B3 (Brad 2026-11-18): one inline script, read-only, sending nothing, which sets one constant class.
    const inline = [...liquid.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(inline).toHaveLength(1);
    expect(inline[0]).not.toMatch(/fetch|XMLHttpRequest|sendBeacon|setItem|removeItem|innerHTML|cookie|\.src\b|import\(/);
    expect([...inline[0].matchAll(/classList\.add\('([^']+)'\)/g)].map((m) => m[1])).toEqual(['hr-widget--saved']);
    // Brad 2026-11-18: an optional heading (escaped) and text beside the calculator (Shopify's richtext), outside the masked root.
    expect(schema.settings.map((s: { id: string; type: string }) => `${s.id}:${s.type}`)).toEqual(['heading:text', 'aside:richtext', 'next_url:url', 'next_label:text']);
    expect(liquid).toContain('{{ block.settings.heading | escape }}');
    expect(liquid.indexOf('hr-widget-aside')).toBeGreaterThan(liquid.indexOf('data-widget="waist-to-height"'));
  });

  it('US-74 B3, AC5: the block\'s inline script marks the card only when this device holds a saved height and an active waist or weight', () => {
    const liquid = src('../../../extensions/health-tool-widget/blocks/waist-to-height.liquid');
    const code = /<script>([\s\S]*?)<\/script>/.exec(liquid)![1];
    // Run in a bare VM context: the page's localStorage (one key) and the card before the script, nothing else.
    const run = (file: unknown) => {
      const added: string[] = [];
      const raw = file === undefined ? null : typeof file === 'string' ? file : JSON.stringify(file);
      runInNewContext(code, {
        JSON,
        localStorage: { getItem: (key: string) => (key === 'health_roadmap_file_v2' ? raw : null) },
        document: { currentScript: { previousElementSibling: { classList: { add: (c: string) => added.push(c) } } } },
      });
      return added;
    };
    const m = (metricType: string, status = 'active') => ({ metricType, status, value: 1 });
    expect(run({ profile: { heightCm: 178 }, measurements: [m('waist')] })).toEqual(['hr-widget--saved']);
    expect(run({ profile: { heightCm: 178 }, measurements: [m('weight')] })).toEqual(['hr-widget--saved']);
    expect(run({ profile: { heightCm: 178 }, measurements: [m('waist', 'entered-in-error'), m('ldl')] })).toEqual([]);
    expect(run({ profile: {}, measurements: [m('waist')] })).toEqual([]);
    expect(run(undefined)).toEqual([]);
    expect(run('{not json')).toEqual([]);
  });

  it('US-75 AC1, AC6, AC7: masks the blood pressure block\'s root; its one inline script reads the device record and adds a class only', () => {
    const liquid = src('../../../extensions/health-tool-widget/blocks/blood-pressure.liquid');
    const rootTag = /<div\b[^>]*data-widget="blood-pressure"[^>]*>/s.exec(liquid);
    expect(rootTag).not.toBeNull();
    expect(rootTag![0]).toContain('data-clarity-mask="true"');
    expect(rootTag![0]).toContain('class="hr-widget"');
    expect(liquid).not.toMatch(/hr-hero|<img|Dr Brad|Stanfield/);
    const schema = JSON.parse(liquid.split('{% schema %}')[1].split('{% endschema %}')[0]);
    expect([schema.name, schema.javascript, schema.stylesheet]).toEqual(['Blood pressure', 'health-widgets.js', 'health-widgets.css']);
    expect(schema.settings.map((s: { id: string; type: string }) => `${s.id}:${s.type}`)).toEqual(['heading:text', 'aside:richtext', 'next_url:url', 'next_label:text']);
    expect(liquid).toContain('{{ block.settings.heading | escape }}');
    // The inline script: one, after the card; it reads localStorage and adds one fixed class, nothing else.
    const scripts = liquid.match(/<script>[\s\S]*?<\/script>/g) ?? [];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).not.toMatch(/fetch|XMLHttpRequest|setItem|removeItem|innerHTML|cookie/);
    expect(scripts[0]).toContain("card.classList.add('hr-widget--saved')");
    expect(liquid.indexOf('<script>')).toBeGreaterThan(liquid.indexOf('data-widget="blood-pressure"'));
    // Run in a bare VM context, as the waist block's: a saved active systolic marks the card; nothing else does.
    const run = (file: unknown) => {
      const added: string[] = [];
      runInNewContext(/<script>([\s\S]*?)<\/script>/.exec(liquid)![1], {
        JSON,
        localStorage: { getItem: (key: string) => (key === 'health_roadmap_file_v2' ? (typeof file === 'string' ? file : file === undefined ? null : JSON.stringify(file)) : null) },
        document: { currentScript: { previousElementSibling: { classList: { add: (c: string) => added.push(c) } } } },
      });
      return added;
    };
    expect(run({ measurements: [{ metricType: 'systolic_bp', status: 'active' }] })).toEqual(['hr-widget--saved']);
    expect(run({ measurements: [{ metricType: 'systolic_bp', status: 'entered-in-error' }, { metricType: 'waist', status: 'active' }] })).toEqual([]);
    expect(run(undefined)).toEqual([]);
    expect(run('{not json')).toEqual([]);
  });

  it('masks the React widget root', () => {
    expect(src('./HealthTool.tsx')).toContain(
      '<div className="health-tool" ref={rootRef} data-clarity-mask="true">',
    );
  });

  it('masks the standalone chat embed, both its React root and its theme block', () => {
    // The embedded chatbot renders the same answers the widget chat does, and
    // it mounts outside the widget root, so it carries its own attribute.
    expect(src('./ChatEmbed.tsx')).toContain(
      '<div className="chat-embed-root no-print" data-clarity-mask="true"',
    );
    const liquid = src('../../../extensions/health-tool-widget/blocks/chatbot-embed.liquid');
    const rootTag = /<div\b[^>]*id="health-chatbot-embed-root"[^>]*>/s.exec(liquid);
    expect(rootTag).not.toBeNull();
    expect(rootTag![0]).toContain('data-clarity-mask="true"');
  });

  it('masks the two remaining <body> portals that show health values', () => {
    // Lab values under review, and the full history lightbox.
    expect(/<div\s+className="upload-modal-backdrop"\s+data-clarity-mask="true"/
      .test(src('./UploadModal.tsx'))).toBe(true);
    expect(/className="hr-modal hr-modal--wide"\s+data-clarity-mask="true"/
      .test(src('../../standalone/history-lightbox.tsx'))).toBe(true);
  });

  it('masks the chat banners: the profile proposal names a sex and height (US-16 AC2)', () => {
    // The rendered check is in HealthTool.chat-profile.test.tsx.
    expect(src('./ChatEdits.tsx')).toContain('<div className="chat-banners no-print" data-clarity-mask="true">');
  });
});
