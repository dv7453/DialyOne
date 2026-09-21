import type { ChatMessage } from "../types";

type Props = {
  messages: ChatMessage[];
};

export function MessageList({ messages }: Props) {
  if (messages.length === 0) return null;
  return (
    <div className="messages">
      {messages.map((m) => {
        if (m.role === "system") {
          return (
            <div key={m.id} className="msg--system">
              <span className="material-symbols-outlined">info</span>
              {m.text}
            </div>
          );
        }
        if (m.role === "user") {
          return (
            <div key={m.id} className="msg-user-wrap">
              <div className="msg--user">{m.text}</div>
              {m.attachment ? <AttachmentCard attachment={m.attachment} /> : null}
            </div>
          );
        }
        return (
          <div key={m.id} className="msg--dialy">
            <div className="msg--dialy-avatar" aria-hidden>
              <span className="material-symbols-outlined">auto_awesome</span>
            </div>
            <div className="msg-dialy-body">
              <div className="msg--dialy-text">{m.text}</div>
              {m.attachment ? <AttachmentCard attachment={m.attachment} /> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AttachmentCard({
  attachment,
}: {
  attachment: NonNullable<ChatMessage["attachment"]>;
}) {
  return (
    <div className="attachment-card">
      <span className="material-symbols-outlined">draft</span>
      <div>
        <p className="attachment-card__name">{attachment.name}</p>
        {attachment.summary ? (
          <p className="attachment-card__summary">{attachment.summary}</p>
        ) : null}
      </div>
    </div>
  );
}
