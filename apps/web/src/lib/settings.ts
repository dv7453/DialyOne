const STORAGE_KEY = "dialy.web.settings.v1";
const AUTH_KEY = "dialy.web.authed.v1";
const SESSION_KEY = "dialy.web.session.v1";

export type WebSettings = {
  brainUrl: string;
  brainToken: string;
};

const DEFAULT: WebSettings = {
  brainUrl: "https://dialyone.onrender.com",
  brainToken: "",
};

export function loadSettings(): WebSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw) as Partial<WebSettings>;
    return {
      brainUrl: (parsed.brainUrl ?? DEFAULT.brainUrl).replace(/\/+$/, ""),
      brainToken: parsed.brainToken ?? "",
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
    }),
  );
}

export function isAuthed(): boolean {
  return localStorage.getItem(AUTH_KEY) === "1";
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
