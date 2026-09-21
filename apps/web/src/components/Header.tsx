import { useTranslation } from "react-i18next";

type Props = {
  brainOk: boolean;
  onCall: () => void;
  onAccess: () => void;
  onSettings: () => void;
};

export function Header({ brainOk, onCall, onAccess, onSettings }: Props) {
  const { t } = useTranslation();
  const brainLabel = brainOk ? t("header.brainOnline") : t("header.brainUnreachable");

  return (
    <header className="header">
      <div className="header__brand">
        <img src="/brand/dialy-mark.png" alt="" className="header__mark" />
        <span className="header__word">{t("brand.name")}</span>
        <span
          className={`status-pip ${brainOk ? "status-pip--ok" : ""}`}
          title={brainLabel}
          aria-label={brainLabel}
        />
      </div>
      <div className="header__actions">
        <button type="button" className="icon-btn" onClick={onCall} aria-label={t("call.open")}>
          <span className="material-symbols-outlined">call</span>
        </button>
        <button type="button" className="icon-btn" onClick={onAccess} aria-label={t("header.access")}>
          <span className="material-symbols-outlined">verified_user</span>
        </button>
        <button type="button" className="icon-btn" onClick={onSettings} aria-label={t("header.settings")}>
          <span className="material-symbols-outlined">more_horiz</span>
        </button>
      </div>
    </header>
  );
}
