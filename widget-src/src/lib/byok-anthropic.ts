/**
 * Shared browser→Anthropic transport for the BYOK (bring-your-own-key)
 * standalone build. Both byok-chat.ts and byok-upload.ts call api.anthropic.com
 * directly with the user's own key; this module owns the one copy of the fetch,
 * the header block, the status→message mapping, and the response-text join so
 * the two callers can't drift (they previously carried five byte-identical
 * error strings each).
 *
 * Throw-based: `callAnthropicDirect` returns the assistant text or throws a
 * `ByokAnthropicError` carrying a stable `code` + a user-facing `message`.
 * Each caller maps that into its own return shape (chat's `{error}` object /
 * upload's `ByokUploadError`).
 */

export type ByokErrorCode = 'unauthorized' | 'rate_limit' | 'bad_request' | 'network' | 'empty' | 'server_error';

export class ByokAnthropicError extends Error {
  constructor(readonly code: ByokErrorCode, message: string) {
    super(message);
    this.name = 'ByokAnthropicError';
  }
}

const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

/** Join the text blocks of an Anthropic Messages response into one string. */
export function extractResponseText(data: unknown): string {
  const blocks = (data as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}

/**
 * POST a Messages request with the user's key and return the assistant text.
 * Throws ByokAnthropicError on transport/auth/empty failures.
 */
export async function callAnthropicDirect(apiKey: string, body: Record<string, unknown>): Promise<string> {
  let response: Response;
  try {
    response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ByokAnthropicError('network', 'Network error reaching Anthropic. Check your connection.');
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new ByokAnthropicError(
        'unauthorized',
        'Anthropic rejected your API key. Disconnect it (link below the chat box) and reconnect with a valid key.',
      );
    }
    if (response.status === 429) {
      throw new ByokAnthropicError(
        'rate_limit',
        'Your Anthropic account is rate-limited right now — wait a minute and try again.',
      );
    }
    if (response.status === 400) {
      // Most common 400 on fresh keys: no credit balance on the account.
      const errBody = await response.json().catch(() => null);
      const detail = (errBody as { error?: { message?: string } })?.error?.message;
      throw new ByokAnthropicError('bad_request', detail ? `Anthropic error: ${detail}` : 'Anthropic rejected the request.');
    }
    throw new ByokAnthropicError('server_error', `Anthropic error (${response.status}). Try again shortly.`);
  }

  const text = extractResponseText(await response.json());
  if (!text) throw new ByokAnthropicError('empty', 'Empty response from Anthropic. Try again.');
  return text;
}
