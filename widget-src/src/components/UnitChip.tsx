// Unit pill: <button> when `onToggle` is given, <span> otherwise.

export function UnitChip({ label, onToggle, title }: { label: string; onToggle?: () => void; title?: string }) {
  if (!onToggle) {
    // Users learn "unit chips toggle" from the weight/waist buttons and then tap
    // fixed-unit chips like mmHg (dead clicks in the 2026-08 audit). The title
    // at least answers the tap on desktop; the chip stays non-interactive.
    return <span className="bt-unit-chip bt-unit-chip--static" title={title ?? 'This unit is fixed'}>{label}</span>;
  }
  return (
    <button type="button" className="bt-unit-chip" title="Click to switch units" onClick={onToggle}>
      {label}
    </button>
  );
}
