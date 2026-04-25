interface ChatHeaderTitleProps {
  subtitle: string;
}

export function ChatHeaderTitle({ subtitle }: ChatHeaderTitleProps) {
  return (
    <>
      <div className="chat-avatar" aria-hidden="true">DR</div>
      <div className="chat-header-title-block">
        <h3>Discuss your health</h3>
        <p className="chat-header-sub">{subtitle}</p>
      </div>
    </>
  );
}
