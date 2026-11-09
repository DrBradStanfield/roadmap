// The settings behind the person button (US-62 AC24), the iPhone's sheet
// (MyDataView.swift settingsList): About you, units, reminders, where the
// record lives and Delete all my data. It holds the parts; their logic stays
// where it was. Drawn in My health's place, as a value page is (US-62 AC10),
// so it stays inside the widget's Clarity mask, its erase lock and its styles
// (the widget root is transformed, so a fixed overlay would not cover the screen).
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Glyph } from './icons';

/** The person button: "Settings" to a screen reader, a person in a circle on screen. */
export function PersonButton({ onClick, buttonRef, open }: { onClick: () => void; buttonRef?: RefObject<HTMLButtonElement>; open: boolean }) {
  return (
    <button type="button" className="mh-person-btn no-print" aria-label="Settings" aria-expanded={open} onClick={onClick} ref={buttonRef}>
      <Glyph name="person" size={28}/>
    </button>
  );
}

/**
 * The settings, in the page's place: its title takes the focus on opening; Done,
 * or Escape inside it with no other dialog open, closes it, and the focus goes
 * back to the person button. On a phone they are the Account tab's panel
 * (US-62 AC34): no `onClose`, so no Done, no Escape and no focus taken from the
 * tab; `action` (where the record lives, or the reconnect) sits on the title's line.
 */
export function SettingsSheet({ onClose, action, children }: { onClose?: () => void; action?: ReactNode; children: ReactNode }) {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const sheet = !!onClose;
  useEffect(() => { if (sheet) titleRef.current?.focus(); }, [sheet]);
  // Another dialog's Escape is its own: the picker's (a native dialog, a portal from
  // inside the sheet) and the alcohol question's (a div, aria-modal).
  const onKeyDown = (e: KeyboardEvent) => {
    if (onClose && e.key === 'Escape' && !document.querySelector('dialog[open], [aria-modal="true"]')) onClose();
  };
  return (
    <section className="md-page mh-settings" aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className="mh-settings-head">
        <h2 className="health-section-title mh-settings-title" id={titleId} tabIndex={-1} ref={titleRef}>{sheet ? 'Settings' : 'Account'}</h2>
        {onClose ? <button type="button" className="md-back mh-settings-done" onClick={onClose}>Done</button> : action && <div className="mh-header-actions">{action}</div>}
      </div>
      {children}
    </section>
  );
}
