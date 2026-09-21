import { useTranslation } from "react-i18next";
import type { LocaleCode } from "../lib/locales";
import { LocaleToggle } from "./LocaleToggle";

export type LoginMode = "email" | "sent" | "exchanging" | "invalid" | "lab";

type Props = {
  mode: LoginMode;
  email: string;
  token: string;
  brainUrl: string;
  locale: LocaleCode;
  error: string | null;
  busy: boolean;
  onEmailChange: (v: string) => void;
  onTokenChange: (v: string) => void;
  onBrainUrlChange: (v: string) => void;
  onLocaleChange: (locale: LocaleCode) => void;
  onSendLink: () => void;
  onLabContinue: () => void;
  onUseDifferentEmail: () => void;
  onRequestNewLink: () => void;
  onShowLab: () => void;
  onHideLab: () => void;
};

export function LoginGate({
  mode,
  email,
  token,
  brainUrl,
  locale,
  error,
  busy,
  onEmailChange,
  onTokenChange,
  onBrainUrlChange,
  onLocaleChange,
  onSendLink,
  onLabContinue,
  onUseDifferentEmail,
  onRequestNewLink,
  onShowLab,
  onHideLab,
}: Props) {
  const { t } = useTranslation();

  return (
    <div className="login-gate">
      <div className="login-gate__card">
        <LocaleToggle value={locale} onChange={onLocaleChange} />
        <img src="/brand/dialy-mark.png" alt="" className="login-gate__mark" />
        <h1 className="login-gate__title">{t("brand.name")}</h1>
        <p className="login-gate__tag">{t("login.tagline")}</p>

        {mode === "exchanging" ? (
          <p className="login-gate__status">{t("login.exchanging")}</p>
        ) : null}

        {mode === "invalid" ? (
          <>
            <h2 className="login-gate__status-title">{t("login.invalidTitle")}</h2>
            <p className="login-gate__status-body">{t("login.invalidBody")}</p>
            <button
              type="button"
              className="btn btn-solid login-gate__cta"
              onClick={onRequestNewLink}
            >
              {t("login.requestNew")}
            </button>
          </>
        ) : null}

        {mode === "sent" ? (
          <>
            <h2 className="login-gate__status-title">{t("login.sentTitle")}</h2>
            <p className="login-gate__status-body">{t("login.sentBody")}</p>
            <button type="button" className="btn-text" onClick={onUseDifferentEmail}>
              {t("login.useDifferent")}
            </button>
          </>
        ) : null}

        {mode === "email" ? (
          <>
            <label className="login-field">
              <span>{t("login.emailLabel")}</span>
              <input
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder={t("login.emailPlaceholder")}
                value={email}
                onChange={(e) => onEmailChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSendLink();
                }}
              />
            </label>
            {error ? <p className="login-gate__error">{error}</p> : null}
            <button
              type="button"
              className="btn btn-solid login-gate__cta"
              disabled={busy || !email.trim()}
              onClick={onSendLink}
            >
              {busy ? t("login.sending") : t("login.sendLink")}
            </button>
            <p className="login-gate__hint">{t("login.hint")}</p>
            <button type="button" className="btn-text" onClick={onShowLab}>
              {t("login.labShow")}
            </button>
          </>
        ) : null}

        {mode === "lab" ? (
          <>
            <label className="login-field">
              <span>{t("login.tokenLabel")}</span>
              <input
                type="password"
                autoComplete="off"
                placeholder={t("login.tokenPlaceholder")}
                value={token}
                onChange={(e) => onTokenChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onLabContinue();
                }}
              />
            </label>
            <label className="login-field login-field--muted">
              <span>{t("login.brainUrlLabel")}</span>
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
              onClick={onLabContinue}
            >
              {t("login.continue")}
            </button>
            <p className="login-gate__hint">{t("login.hint")}</p>
            <button type="button" className="btn-text" onClick={onHideLab}>
              {t("login.labHide")}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
