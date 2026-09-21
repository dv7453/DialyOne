import { useTranslation } from "react-i18next";
import { LOCALES, type LocaleCode } from "../lib/locales";
import { setAppLocale } from "../lib/i18n";

type Props = {
  value: LocaleCode;
  onChange: (locale: LocaleCode) => void;
  align?: "center" | "start";
};

export function LocaleToggle({ value, onChange, align = "center" }: Props) {
  const { t } = useTranslation();

  return (
    <div
      className={`locale-toggle${align === "start" ? " locale-toggle--start" : ""}`}
      role="group"
      aria-label={t("settings.language")}
    >
      {LOCALES.map((locale, index) => (
        <span key={locale.code} className="locale-toggle__item">
          {index > 0 ? (
            <span className="locale-toggle__rule" aria-hidden>
              ·
            </span>
          ) : null}
          <button
            type="button"
            className={`locale-toggle__btn${value === locale.code ? " is-active" : ""}`}
            aria-pressed={value === locale.code}
            onClick={() => {
              setAppLocale(locale.code);
              onChange(locale.code);
            }}
          >
            {locale.nativeName}
          </button>
        </span>
      ))}
    </div>
  );
}
