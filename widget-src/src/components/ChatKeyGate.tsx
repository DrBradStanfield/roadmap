/**
 * ChatKeyGate — shown in place of the chat messages + input when the chat
 * gate (chat-api getChatGate) reports a missing API key. Only ever renders on
 * the standalone build: the Shopify widget's gate is null, so this component
 * is dead code there (tree-shaken with the byok module it accompanies).
 */
import { useState, useCallback } from 'react';
import type { ChatGate } from '../lib/chat-api';

interface ChatKeyGateProps {
  gate: ChatGate;
  /** Called after a key is saved so the parent re-renders past the gate. */
  onConnected: () => void;
}

export function ChatKeyGate({ gate, onConnected }: ChatKeyGateProps) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSave = useCallback(() => {
    const err = gate.saveKey(key);
    if (err) { setError(err); return; }
    setError(null);
    onConnected();
  }, [gate, key, onConnected]);

  return (
    <div className="chat-key-gate">
      <p className="chat-key-gate-title">This chat runs on Claude (Anthropic)</p>
      <p className="chat-key-gate-copy">
        On this page, chat uses <strong>your own Anthropic API key</strong>. The key is stored only on
        this device — it is never sent to our servers, and your messages go directly from your browser
        to Anthropic. Usage is billed to your Anthropic account (typically well under a cent per question).
      </p>
      <p className="chat-key-gate-copy">
        Prefer not to set one up? Chat is free at{' '}
        <a href="https://drstanfield.com/pages/roadmap" target="_blank" rel="noopener noreferrer">drstanfield.com</a>.
      </p>
      <div className="chat-key-gate-form">
        <input
          type="password"
          value={key}
          onChange={(e) => { setKey(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          placeholder="sk-ant-…"
          aria-label="Anthropic API key"
          autoComplete="off"
        />
        <button type="button" onClick={handleSave} disabled={!key.trim()}>
          Connect
        </button>
      </div>
      {error && <p className="chat-key-gate-error">{error}</p>}
      <p className="chat-key-gate-fineprint">
        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">
          Get an API key from Anthropic →
        </a>{' '}
        Tip: create a dedicated key and set a low monthly spend limit on it.
      </p>
    </div>
  );
}
