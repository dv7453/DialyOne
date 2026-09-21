import {
  DEFAULT_CALL_LANGUAGE,
  parseCallLanguage,
  type CallLanguage,
} from "./call-language";
import { DEFAULT_LOCALE, isLocaleCode, type LocaleCode } from "./locales";

const STORAGE_KEY = "dialy.web.settings.v1";
const AUTH_KEY = "dialy.web.authed.v1";
const SESSION_KEY = "dialy.web.session.v1";

export type AuthKind = "none" | "session" | "static";

export type WebSettings = {
  brainUrl: string;
  brainToken: string;
  authKind: AuthKind;
  locale: LocaleCode;
  voiceTokenUrl: string;
  callLanguage: CallLanguage;
};

function defaultVoiceTokenUrl(): string {
  const fromEnv = import.meta.env.VITE_VOICE_TOKEN_URL;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.replace(/\/+$/, "");
  }
  return "http://127.0.0.1:7890";
}

const DEFAULT: WebSettings = {
  brainUrl: "https://dialyone.onrender.com",
  brainToken: "",
  authKind: "none",
  locale: DEFAULT_LOCALE,
  voiceTokenUrl: defaultVoiceTokenUrl(),
  callLanguage: DEFAULT_CALL_LANGUAGE,
};

function parseLocale(value: unknown): LocaleCode {
  return isLocaleCode(value) ? value : DEFAULT_LOCALE;
}

function parseAuthKind(value: unknown, legacyAuthed: boolean): AuthKind {
  if (value === "session" || value === "static" || value === "none") return value;
  if (legacyAuthed) return "static";
  return "none";
}

export function loadSettings(): WebSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw) as Partial<WebSettings>;
    const brainToken = parsed.brainToken ?? "";
    const legacyAuthed = localStorage.getItem(AUTH_KEY) === "1";
    return {
      brainUrl: (parsed.brainUrl ?? DEFAULT.brainUrl).replace(/\/+$/, ""),
      brainToken,
      authKind: parseAuthKind(parsed.authKind, legacyAuthed),
      locale: parseLocale(parsed.locale),
      voiceTokenUrl: (parsed.voiceTokenUrl ?? DEFAULT.voiceTokenUrl).replace(/\/+$/, ""),
      callLanguage: parseCallLanguage(parsed.callLanguage),
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveSettings(next: WebSettings): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      brainUrl: next.brainUrl.replace(/\/+$/, ""),
      brainToken: next.brainToken,
      authKind: next.authKind,
      locale: parseLocale(next.locale),
      voiceTokenUrl: next.voiceTokenUrl.replace(/\/+$/, ""),
      callLanguage: parseCallLanguage(next.callLanguage),
    }),
  );
  if (next.authKind === "none") localStorage.removeItem(AUTH_KEY);
  else localStorage.setItem(AUTH_KEY, "1");
}

export function isAuthed(settings: WebSettings = loadSettings()): boolean {
  return settings.authKind !== "none";
}

export function setAuthed(value: boolean): void {
  if (value) localStorage.setItem(AUTH_KEY, "1");
  else localStorage.removeItem(AUTH_KEY);
}

export function loadSessionId(): string | null {
  return localStorage.getItem(SESSION_KEY);
}

export function saveSessionId(id: string | null): void {
  if (id) localStorage.setItem(SESSION_KEY, id);
  else localStorage.removeItem(SESSION_KEY);
}

export function clearAuthSettings(current: WebSettings): WebSettings {
  const next: WebSettings = {
    ...current,
    brainToken: current.authKind === "session" ? "" : current.brainToken,
    authKind: "none",
  };
  saveSettings(next);
  return next;
}
