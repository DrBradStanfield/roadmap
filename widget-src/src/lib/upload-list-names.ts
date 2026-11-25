// What a screen reader calls each value and day control on the web upload list (US-13 AC10). The engine composes full
// names (`ListRow.name`, `DayControl.name`), but that composition awaits Brad's yes (docs/decisions-for-brad.md, Open).
// Until then the controls keep their labels. His yes flips this one line.
export const ENGINE_NAMES = false;

export const rowName = (row: { label: string; name: string }) => (ENGINE_NAMES ? row.name : row.label);
export const dayName = (control: { label: string; name: string }) => (ENGINE_NAMES ? control.name : control.label);
