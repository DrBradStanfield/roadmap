/**
 * What a chat turn leaves on our server, from the surface the route computed.
 * The single source for api.chat.ts's storage branches and its saved-chat answer.
 * - 'none': the iPhone app's turn (US-52 AC5, D9). No row at all.
 * - 'question-rows': the widget's turn (`localFirst`, US-15 AC7). Only the
 *   masked question row (chat_match_events); its history arrives in the body.
 * - 'transcript': the bubble and the embed (US-15 AC8). The conversation and
 *   its messages, kept server-side.
 */
export type Retention = 'none' | 'question-rows' | 'transcript';

export function retentionOf({ app, widget }: { app: boolean; widget: boolean }): Retention {
  if (app) return 'none';
  return widget ? 'question-rows' : 'transcript';
}
