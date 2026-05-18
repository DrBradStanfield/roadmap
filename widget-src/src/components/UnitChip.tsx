// Tiny pill rendered next to a row's metric label showing the unit. When
// `onToggle` is provided the chip is a button that switches units (used on
// core rows in both the live timeline and the lab-upload matrix). Without
// `onToggle` it falls back to a static span so additional-row chips don't
// look clickable.

export function UnitChip({ label, onToggle }: { label: string; onToggle?: () => void }) {
  if (!onToggle) {
    return <span className="bt-unit-chip bt-unit-chip--static">{label}</span>;
  }
  return (
    <button type="button" className="bt-unit-chip" title="Click to switch units" onClick={onToggle}>
      {label}
    </button>
  );
}
