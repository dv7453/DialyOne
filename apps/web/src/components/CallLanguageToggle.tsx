import { useTranslation } from "react-i18next";
import { CALL_LANGUAGES, CALL_LANGUAGE_I18N, type CallLanguage } from "../lib/call-language";

type Props = {
  value: CallLanguage;
  onChange: (language: CallLanguage) => void;
  disabled?: boolean;
};

export function CallLanguageToggle({ value, onChange, disabled }: Props) {
  const { t } = useTranslation();

  return (
    <div className="locale-toggle" role="radiogroup" aria-label={t("call.languageLabel")}>
      {CALL_LANGUAGES.map((code, index) => (
        <span key={code} className="locale-toggle__item">
          {index > 0 ? (
            <span className="locale-toggle__rule" aria-hidden>
              ·
            </span>
          ) : null}
          <button
            type="button"
            className={`locale-toggle__btn${value === code ? " is-active" : ""}`}
            role="radio"
            aria-checked={value === code}
            disabled={disabled}
            onClick={() => onChange(code)}
          >
            {t(CALL_LANGUAGE_I18N[code])}
          </button>
        </span>
      ))}
    </div>
  );
}
