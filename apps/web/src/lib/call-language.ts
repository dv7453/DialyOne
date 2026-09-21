export const CALL_LANGUAGES = ["gu-IN", "hi-IN", "en-IN"] as const;

export type CallLanguage = (typeof CALL_LANGUAGES)[number];

export const DEFAULT_CALL_LANGUAGE: CallLanguage = "gu-IN";

export const CALL_LANGUAGE_I18N: Record<CallLanguage, string> = {
  "gu-IN": "call.languages.gu",
  "hi-IN": "call.languages.hi",
  "en-IN": "call.languages.en",
};

export function isCallLanguage(value: unknown): value is CallLanguage {
  return typeof value === "string" && (CALL_LANGUAGES as readonly string[]).includes(value);
}

export function parseCallLanguage(value: unknown): CallLanguage {
  return isCallLanguage(value) ? value : DEFAULT_CALL_LANGUAGE;
}
