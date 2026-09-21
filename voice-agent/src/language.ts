/**
 * Per-session spoken language for Sarvam STT/TTS.
 *
 * Hindi (`hi-IN`) and English (`en-IN`) are the same pipeline as Gujarati —
 * only this BCP-47 value changes. STT stays on `codemix` for all three so
 * Gujarati–English and Hindi–English mixed speech keep working.
 */
export const DEFAULT_LANGUAGE = "gu-IN";

export const SUPPORTED_LANGUAGES = ["gu-IN", "hi-IN", "en-IN"] as const;

export type SessionLanguage = (typeof SUPPORTED_LANGUAGES)[number];

const LANGUAGE_ALIASES: Record<string, SessionLanguage> = {
  gu: "gu-IN",
  "gu-in": "gu-IN",
  gujarati: "gu-IN",
  hi: "hi-IN",
  "hi-in": "hi-IN",
  hindi: "hi-IN",
  en: "en-IN",
  "en-in": "en-IN",
  "en-us": "en-IN",
  "en-gb": "en-IN",
  english: "en-IN",
};

const ATTR_KEYS = ["language", "user.language", "languageCode"] as const;

export function isSessionLanguage(value: string): value is SessionLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

export function parseLanguageCode(raw: string | undefined | null): SessionLanguage | undefined {
  if (raw == null) return undefined;
  const key = raw.trim().toLowerCase();
  if (!key) return undefined;
  for (const lang of SUPPORTED_LANGUAGES) {
    if (lang.toLowerCase() === key) return lang;
  }
  return LANGUAGE_ALIASES[key];
}

export function languageFromAttributes(
  attrs: Record<string, string> | null | undefined,
): SessionLanguage | undefined {
  if (!attrs) return undefined;
  for (const key of ATTR_KEYS) {
    const parsed = parseLanguageCode(attrs[key]);
    if (parsed) return parsed;
  }
  return undefined;
}

/**
 * Room / job metadata may be a bare language code or JSON:
 * `{ "language": "hi-IN" }` or `{ "languageCode": "en-IN" }`.
 */
export function languageFromMetadata(raw: string | null | undefined): SessionLanguage | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const direct = parseLanguageCode(trimmed);
  if (direct) return direct;

  try {
    const obj = JSON.parse(trimmed) as unknown;
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const record = obj as Record<string, unknown>;
      if (typeof record.language === "string") {
        const parsed = parseLanguageCode(record.language);
        if (parsed) return parsed;
      }
      if (typeof record.languageCode === "string") {
        const parsed = parseLanguageCode(record.languageCode);
        if (parsed) return parsed;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Resolution order (most specific first), matching LiveKit job-customization docs:
 * 1. remote participant attributes (`language`, then `user.language`, then `languageCode`)
 * 2. room metadata
 * 3. job metadata (explicit dispatch)
 * 4. `gu-IN`
 *
 * LiveKit does not define a precedence between these sources; this order is our
 * choice and is covered by tests.
 */
export function resolveSessionLanguage(input: {
  participantAttributes?: Record<string, string> | null;
  roomMetadata?: string | null;
  jobMetadata?: string | null;
}): SessionLanguage {
  return (
    languageFromAttributes(input.participantAttributes) ??
    languageFromMetadata(input.roomMetadata) ??
    languageFromMetadata(input.jobMetadata) ??
    DEFAULT_LANGUAGE
  );
}
