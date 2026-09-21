type Props = {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onMic: () => void;
  onAttach: () => void;
  disabled?: boolean;
  canAttach?: boolean;
};

export function Composer({
  value,
  onChange,
  onSend,
  onMic,
  onAttach,
  disabled,
  canAttach = true,
}: Props) {
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      <div className="composer__shell">
        <button
          type="button"
          className="composer__icon"
          onClick={onAttach}
          disabled={disabled || !canAttach}
          aria-label="Attach"
        >
          <span className="material-symbols-outlined">add</span>
        </button>
        <textarea
          className="composer__input"
          rows={1}
          placeholder="Message Dialy…"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
        />
        <button
          type="button"
          className="composer__icon"
          onClick={onMic}
          disabled={disabled}
          aria-label="Voice"
        >
          <span className="material-symbols-outlined">mic</span>
        </button>
        <button
          type="submit"
          className="composer__send"
          disabled={disabled || !value.trim()}
          aria-label="Send"
        >
          <span className="material-symbols-outlined">arrow_upward</span>
        </button>
      </div>
    </form>
  );
}
