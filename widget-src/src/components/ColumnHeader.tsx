/** A column's header, the chat column's since My health has no columns 1 and 2 (US-62 AC16): no step number. */
interface ColumnHeaderProps {
  title: string;
  muted?: boolean;
}

export function ColumnHeader({ title, muted }: ColumnHeaderProps) {
  return (
    <div className={`hr-col-header${muted ? ' hr-col-header--muted' : ''}`}>
      <div className="hr-col-title">{title}</div>
    </div>
  );
}
