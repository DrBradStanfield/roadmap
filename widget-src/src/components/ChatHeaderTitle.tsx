interface ChatHeaderTitleProps {
  subtitle: string;
  muted?: boolean;
}

export function ChatHeaderTitle({ subtitle, muted }: ChatHeaderTitleProps) {
  return (
    <>
      <div className={`chat-avatar${muted ? ' chat-avatar--muted' : ''}`} aria-hidden="true">DR</div>
      <div className="chat-header-title-block">
        <h3>Discuss your health</h3>
        <p className="chat-header-sub">{subtitle}</p>
      </div>
    </>
  );
}
