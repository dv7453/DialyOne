type Props = {
  brainOk: boolean;
  onSignOut: () => void;
};

export function Header({ brainOk, onSignOut }: Props) {
  return (
    <header className="header">
      <div className="header__brand">
        <img src="/brand/dialy-mark.png" alt="" className="header__mark" />
        <span className="header__word">Dialy</span>
        <span
          className={`status-pip ${brainOk ? "status-pip--ok" : ""}`}
          title={brainOk ? "Brain online" : "Brain unreachable"}
          aria-label={brainOk ? "Brain online" : "Brain unreachable"}
        />
      </div>
      <button type="button" className="icon-btn" onClick={onSignOut} aria-label="Sign out">
        <span className="material-symbols-outlined">more_horiz</span>
      </button>
    </header>
  );
}
