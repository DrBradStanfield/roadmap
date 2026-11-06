// The settings behind the person button (US-62 AC24), the iPhone's sheet
// (MyDataView.swift settingsList): About you, units, reminders, where the
// record lives and Delete all my data. It holds the parts; their logic stays
// where it was. Drawn in My health's place, as a value page is (US-62 AC10),
// so it stays inside the widget's Clarity mask, its erase lock and its styles
// (the widget root is transformed, so a fixed overlay would not cover the screen).
import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
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
 * The settings, in the page's place: its title takes the focus on opening; Done
 * or Escape closes it, and the focus goes back to the person button.
 */
export function SettingsSheet({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  return (
    <section className="md-page mh-settings" aria-labelledby={titleId}>
      <div className="mh-settings-head">
        <h2 className="health-section-title mh-settings-title" id={titleId} tabIndex={-1} ref={titleRef}>Settings</h2>
        <button type="button" className="md-back mh-settings-done" onClick={onClose}>Done</button>
      </div>
      {children}
    </section>
  );
}
