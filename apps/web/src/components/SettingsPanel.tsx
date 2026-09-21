import { useEffect, useState } from "react";
import type { AdapterFlags } from "../types";
import type { WebSettings } from "../lib/settings";
import { fetchCapabilities } from "../lib/brain";

type Props = {
  settings: WebSettings;
  onSave: (s: WebSettings) => void;
  onClose: () => void;
};

const CONNECTOR_META: { key: keyof AdapterFlags; label: string; icon: string }[] = [
  { key: "render", label: "Render", icon: "cloud" },
  { key: "github", label: "GitHub", icon: "code" },
  { key: "mail", label: "Gmail", icon: "mail" },
  { key: "telegram", label: "Telegram", icon: "send" },
  { key: "calendar", label: "Calendar", icon: "calendar_today" },
];

export function SettingsPanel({ settings, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(settings);
  const [flags, setFlags] = useState<AdapterFlags | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void fetchCapabilities(draft)
      .then((r) => {
        setFlags(r.flags);
        setErr(null);
      })
      .catch((e: Error) => setErr(e.message));
  }, [draft.brainUrl, draft.brainToken]);

  return (
    <div className="settings-overlay" onClick={onClose} role="presentation">
      <div
        className="settings-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Settings"
      >
        <div className="settings-handle" aria-hidden />
        <div className="settings-panel__header">
          <h1 className="settings-panel__title">
            <img src="/brand/dialy-mark.png" alt="" className="header__mark" />
            Settings
          </h1>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="settings-panel__body">
          {err ? <div className="error-banner">{err}</div> : null}

          <section>
            <h2 className="settings-section__label">Brain configuration</h2>
            <div className="field">
              <label htmlFor="brain-url">
                <span className="material-symbols-outlined">api</span>
                Endpoint URL
              </label>
              <input
                id="brain-url"
                value={draft.brainUrl}
                onChange={(e) => setDraft({ ...draft, brainUrl: e.target.value })}
              />
              <p className="field__hint">Primary endpoint for AI logic execution.</p>
            </div>
            <div className="field">
              <label htmlFor="brain-token">
                <span className="material-symbols-outlined">key</span>
                Brain token (optional)
              </label>
              <input
                id="brain-token"
                type="password"
                autoComplete="off"
                value={draft.brainToken}
                onChange={(e) => setDraft({ ...draft, brainToken: e.target.value })}
              />
            </div>
          </section>

          <section>
            <h2 className="settings-section__label">
              Live connectors
              <span className="settings-badge">Status</span>
            </h2>
            <div className="live-list">
              {CONNECTOR_META.map(({ key, label, icon }) => {
                const on = Boolean(flags?.[key]);
                return (
                  <div key={key} className={`live-row ${on ? "" : "live-row--off"}`}>
                    <div className="live-row__left">
                      <span className="material-symbols-outlined">{icon}</span>
                      <span>{label}</span>
                    </div>
                    <div
                      className={`live-row__status ${on ? "live-row__status--on" : "live-row__status--off"}`}
                    >
                      <span className={`live-dot ${on ? "live-dot--on" : ""}`} />
                      <span>{on ? "live" : "inactive"}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <footer className="settings-panel__footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-solid"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  );
}
