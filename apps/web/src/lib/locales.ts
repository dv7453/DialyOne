import en from "../locales/en.json";
import gu from "../locales/gu.json";

/**
 * Single registry of bundled UI languages.
 * To add Hindi, Tamil, or Malayalam later: add a JSON file under
 * `src/locales/` and one object here. Switchers and i18n both read this list.
 */
export const LOCALES = [
  { code: "en", nativeName: "English", resources: en },
  { code: "gu", nativeName: "ગુજરાતી", resources: gu },
] as const;

export type LocaleCode = (typeof LOCALES)[number]["code"];

export const DEFAULT_LOCALE: LocaleCode = "en";

export function isLocaleCode(value: unknown): value is LocaleCode {
  return typeof value === "string" && LOCALES.some((locale) => locale.code === value);
}

export function voiceLanguageCode(locale: string): string {
  if (locale === "gu") return "gu-IN";
  if (locale === "hi") return "hi-IN";
  return "en-IN";
}

export function applyDocumentLang(locale: string): void {
  document.documentElement.lang = locale;
}
