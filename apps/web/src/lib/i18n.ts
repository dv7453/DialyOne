import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { loadSettings, saveSettings } from "./settings";
import {
  applyDocumentLang,
  DEFAULT_LOCALE,
  LOCALES,
  type LocaleCode,
} from "./locales";

const resources = Object.fromEntries(
  LOCALES.map((locale) => [locale.code, { translation: locale.resources }]),
);

let started = false;

export function initI18n(): void {
  if (started) return;
  started = true;
  const locale = loadSettings().locale;
  void i18n.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
  applyDocumentLang(locale);
}

export function setAppLocale(locale: LocaleCode): void {
  void i18n.changeLanguage(locale);
  applyDocumentLang(locale);
  saveSettings({ ...loadSettings(), locale });
}

export { i18n };
