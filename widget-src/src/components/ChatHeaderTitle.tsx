interface ChatHeaderTitleProps {
  title?: string;
  subtitle: string;
}

export function ChatHeaderTitle({ title = 'Discuss your health', subtitle }: ChatHeaderTitleProps) {
  return (
    <div className="chat-header-title-block">
      <h3>{title}</h3>
      <p className="chat-header-sub">{subtitle}</p>
    </div>
  );
}