import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AdapterFlags, MeUser } from "../types";
import { deleteAccount, exportAccount, fetchCapabilities } from "../lib/brain";
import { isNotImplemented } from "../lib/errors";
import type { WebSettings } from "../lib/settings";
import { LocaleToggle } from "./LocaleToggle";

type Props = {
  settings: WebSettings;
  me: MeUser | null;
  onSave: (s: WebSettings) => void;
  onClose: () => void;
  onSignOut: () => void;
  onDeleted: () => void;
};

const CONNECTOR_META: {
  key: "render" | "github" | "mail" | "telegram" | "calendar";
  icon: string;
}[] = [
  { key: "render", icon: "cloud" },
  { key: "github", icon: "code" },
  { key: "mail", icon: "mail" },
  { key: "telegram", icon: "send" },
  { key: "calendar", icon: "calendar_today" },
];

export function SettingsPanel({ settings, me, onSave, onClose, onSignOut, onDeleted }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(settings);
  const [flags, setFlags] = useState<AdapterFlags | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteTyped, setDeleteTyped] = useState("");

  useEffect(() => {
    void fetchCapabilities(draft)
      .then((r) => {
        setFlags(r.flags);
        setErr(null);
      })
      .catch((e: Error) => setErr(e.message));
  }, [draft.brainUrl, draft.brainToken]);

  async function handleExport() {
    setExporting(true);
    setErr(null);
    try {
      const data = await exportAccount(draft);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `dialy-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(isNotImplemented(e) ? t("settings.exportUnavailable") : t("settings.exportFailed"));
    } finally {
      setExporting(false);
    }
  }

  async function handleDelete() {
    const email = me?.email?.trim().toLowerCase() ?? "";
    if (!email) {
      setErr(t("settings.deleteNeedEmail"));
      return;
    }
    if (deleteTyped.trim().toLowerCase() !== email) {
      setErr(t("settings.deleteMismatch"));
      return;
    }
    setDeleting(true);
    setErr(null);
    try {
      await deleteAccount(draft);
      onDeleted();
    } catch (e) {
      setErr(isNotImplemented(e) ? t("settings.deleteUnavailable") : t("settings.deleteFailed"));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="settings-overlay" onClick={onClose} role="presentation">
      <div
        className="settings-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("settings.title")}
      >
        <div className="settings-handle" aria-hidden />
        <div className="settings-panel__header">
          <h1 className="settings-panel__title">
            <img src="/brand/dialy-mark.png" alt="" className="header__mark" />
            {t("settings.title")}
          </h1>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t("common.close")}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        <div className="settings-panel__body">
          {err ? <div className="error-banner">{err}</div> : null}

          <section>
            <h2 className="settings-section__label">{t("settings.language")}</h2>
            <LocaleToggle
              value={draft.locale}
              align="start"
              onChange={(locale) => setDraft((current) => ({ ...current, locale }))}
            />
          </section>

          <section>
            <h2 className="settings-section__label">{t("settings.account")}</h2>
            <button
              type="button"
              className="btn btn-ghost settings-account__btn"
              disabled={exporting}
              onClick={() => void handleExport()}
            >
              {exporting ? t("settings.exporting") : t("settings.export")}
            </button>
            <p className="field__hint">{t("settings.exportHint")}</p>
            {!deleteOpen ? (
              <button
                type="button"
                className="btn btn-ghost settings-account__btn settings-account__danger"
                onClick={() => {
                  setDeleteOpen(true);
                  setErr(null);
                }}
              >
                {t("settings.delete")}
              </button>
            ) : (
              <div className="settings-delete">
                <p className="settings-delete__warn">{t("settings.deleteWarn")}</p>
                {me?.email ? (
                  <>
                    <label className="login-field">
                      <span>{t("settings.deleteConfirmLabel")}</span>
                      <input
                        type="email"
                        autoComplete="off"
                        value={deleteTyped}
                        onChange={(e) => setDeleteTyped(e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn btn-solid settings-account__btn"
                      disabled={deleting || !deleteTyped.trim()}
                      onClick={() => void handleDelete()}
                    >
                      {deleting ? t("settings.deleting") : t("settings.deleteConfirmCta")}
                    </button>
                  </>
                ) : (
                  <p className="field__hint">{t("settings.deleteNeedEmail")}</p>
                )}
              </div>
            )}
            <button type="button" className="btn btn-ghost settings-account__btn" onClick={onSignOut}>
              {t("settings.signOut")}
            </button>
          </section>

          <section>
            <h2 className="settings-section__label">{t("settings.brainSection")}</h2>
            <div className="field">
              <label htmlFor="brain-url">
                <span className="material-symbols-outlined">api</span>
                {t("settings.endpointUrl")}
              </label>
              <input
                id="brain-url"
                value={draft.brainUrl}
                onChange={(e) => setDraft({ ...draft, brainUrl: e.target.value })}
              />
              <p className="field__hint">{t("settings.endpointHint")}</p>
            </div>
            <div className="field">
              <label htmlFor="brain-token">
                <span className="material-symbols-outlined">key</span>
                {t("settings.brainToken")}
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
              {t("settings.connectorsSection")}
              <span className="settings-badge">{t("settings.statusBadge")}</span>
            </h2>
            <div className="live-list">
              {CONNECTOR_META.map(({ key, icon }) => {
                const on = Boolean(flags?.[key]);
                return (
                  <div key={key} className={`live-row ${on ? "" : "live-row--off"}`}>
                    <div className="live-row__left">
                      <span className="material-symbols-outlined">{icon}</span>
                      <span>{t(`settings.connectors.${key}`)}</span>
                    </div>
                    <div
                      className={`live-row__status ${on ? "live-row__status--on" : "live-row__status--off"}`}
                    >
                      <span className={`live-dot ${on ? "live-dot--on" : ""}`} />
                      <span>{on ? t("settings.live") : t("settings.inactive")}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <footer className="settings-panel__footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-solid"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            {t("common.save")}
          </button>
        </footer>
      </div>
    </div>
  );
}
