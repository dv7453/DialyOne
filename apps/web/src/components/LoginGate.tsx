type Props = {
  token: string;
  brainUrl: string;
  error: string | null;
  busy: boolean;
  onTokenChange: (v: string) => void;
  onBrainUrlChange: (v: string) => void;
  onContinue: () => void;
};

export function LoginGate({
  token,
  brainUrl,
  error,
  busy,
  onTokenChange,
  onBrainUrlChange,
  onContinue,
}: Props) {
  return (
    <div className="login-gate">
      <div className="login-gate__card">
        <img src="/brand/dialy-mark.png" alt="" className="login-gate__mark" />
        <h1 className="login-gate__title">Dialy</h1>
        <p className="login-gate__tag">A private assistant wired into your world.</p>

        <label className="login-field">
          <span>Access token</span>
          <input
            type="password"
            autoComplete="off"
            placeholder="Paste BRAIN_TOKEN if set"
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onContinue();
            }}
          />
        </label>

        <label className="login-field login-field--muted">
          <span>Brain URL</span>
          <input
            type="url"
            value={brainUrl}
            onChange={(e) => onBrainUrlChange(e.target.value)}
          />
        </label>

        {error ? <p className="login-gate__error">{error}</p> : null}

        <button
          type="button"
          className="btn btn-solid login-gate__cta"
          disabled={busy}
          onClick={onContinue}
        >
          Continue
        </button>
        <p className="login-gate__hint">Talks to your Dialy brain.</p>
      </div>
    </div>
  );
}
