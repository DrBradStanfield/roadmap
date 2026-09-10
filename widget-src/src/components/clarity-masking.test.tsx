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
  THINKING_MESSAGES: ['Thinking…'],
  MAX_CHARS: 2000,
  useChatState: () => ({
    state: {
      conversations: [], activeConversationId: null, messages: [], inputText: '',
      isLoading: false, isLocalSender: false, error: null, thinkingIndex: 0, isOffline: false,
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

  it('masks the React widget root', () => {
    expect(src('./HealthTool.tsx')).toContain(
      "className={`health-tool${planBarVisible ? ' health-tool--plan-bar' : ''}`} data-clarity-mask=\"true\"",
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
});
