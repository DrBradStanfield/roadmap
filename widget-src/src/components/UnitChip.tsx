// Unit pill: <button> when `onToggle` is given, <span> otherwise.

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
