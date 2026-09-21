import type {
  AdapterFlags,
  ApprovalRecord,
  ChatAttachment,
  JournalEntry,
  MeUser,
  OperatorCapabilities,
  PlaybookSummary,
  ResolvedApproval,
  SessionExchange,
  TrustRecord,
} from "../types";
import { BrainHttpError } from "./errors";
import { i18n } from "./i18n";
import type { WebSettings } from "./settings";

export type ChatResponse = {
  sessionId: string;
  turnId: string;
  status: "completed" | "failed" | "cancelled" | "ask_human" | "suspended" | "timeout";
  text: string | null;
  error?: string;
  askHuman?: { toolCallId: string; query: string; options?: string[] };
};

function headers(settings: WebSettings): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
  };
  if (settings.brainToken.trim()) {
    h.Authorization = `Bearer ${settings.brainToken.trim()}`;
  }
  return h;
}

function extraHeaders(init?: RequestInit): Record<string, string> {
  if (!init?.headers) return {};
  if (init.headers instanceof Headers) {
    const out: Record<string, string> = {};
    init.headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(init.headers)) {
    return Object.fromEntries(init.headers);
  }
  return { ...init.headers };
}

function errorFromBody(status: number, body: unknown, fallback: string): BrainHttpError {
  const err =
    body && typeof body === "object"
      ? (body as { message?: unknown; error?: unknown; hint?: unknown })
      : {};
  const code = typeof err.error === "string" ? err.error : `http_${status}`;
  const message =
    (typeof err.message === "string" && err.message) ||
    (typeof err.error === "string" && err.error) ||
    fallback;
  return new BrainHttpError(status, code, message);
}

async function request<T>(settings: WebSettings, path: string, init?: RequestInit): Promise<T> {
  const url = `${settings.brainUrl}${path}`;
  const res = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      ...headers(settings),
      ...extraHeaders(init),
    },
  });
  const text = await res.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!res.ok) {
    throw errorFromBody(res.status, body, `HTTP ${res.status}`);
  }
  return body as T;
}

export async function fetchHealth(settings: WebSettings): Promise<{ bootOk?: boolean }> {
  return request(settings, "/health");
}

export async function fetchCapabilities(settings: WebSettings): Promise<OperatorCapabilities> {
  return request(settings, "/v1/operator/capabilities");
}

/** Real brain route is `/v1/operator/capabilities` (there is no `/v1/operator/status`). */
export async function fetchOperatorStatus(settings: WebSettings): Promise<OperatorCapabilities> {
  return fetchCapabilities(settings);
}

export async function fetchPlaybooks(settings: WebSettings): Promise<PlaybookSummary[]> {
  const data = await request<{ playbooks?: PlaybookSummary[] }>(
    settings,
    "/v1/operator/playbooks",
  );
  return data.playbooks ?? [];
}

export async function fetchApprovals(settings: WebSettings): Promise<ApprovalRecord[]> {
  const data = await request<{ approvals: ApprovalRecord[] }>(settings, "/v1/operator/approvals");
  return data.approvals ?? [];
}

export async function resolveApproval(
  settings: WebSettings,
  approvalId: string,
  decision: "approve" | "deny",
): Promise<ResolvedApproval> {
  const data = await request<{
    ok: boolean;
    approval?: ApprovalRecord;
    execution?: { ok?: boolean; error?: string; data?: Record<string, unknown> };
    error?: string;
  }>(settings, "/v1/operator/approvals/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approvalId, decision }),
  });

  const exec = data.execution;
  let summary: string | undefined;
  if (decision === "approve" && exec) {
    if (exec.data?.dryRun === true) {
      summary = i18n.t("approvals.draftPrepared");
    } else if (exec.ok) {
      summary = i18n.t("approvals.executed");
    } else if (exec.error) {
      summary = exec.error;
    }
  }

  return {
    approval: data.approval as ApprovalRecord,
    decision,
    ok: Boolean(data.ok),
    summary,
  };
}

export async function sendChat(
  settings: WebSettings,
  input: {
    sessionId?: string | null;
    message: string;
    attachments?: ChatAttachment[];
  },
): Promise<ChatResponse> {
  return request(settings, "/v1/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: input.sessionId || undefined,
      message: input.message,
      attachments: input.attachments,
    }),
  });
}

export async function answerAskHuman(
  settings: WebSettings,
  input: {
    sessionId: string;
    turnId: string;
    toolCallId: string;
    text: string;
  },
): Promise<ChatResponse> {
  return request(settings, "/v1/chat/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function transcribeVoice(
  settings: WebSettings,
  audioBase64: string,
  mimeType?: string,
): Promise<{ transcript: string }> {
  return request(settings, "/v1/voice/transcribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioBase64, mimeType }),
  });
}

export async function speakVoice(
  settings: WebSettings,
  text: string,
): Promise<{ audioBase64: string; mimeType: string }> {
  return request(settings, "/v1/voice/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

export async function requestMagicLink(
  settings: WebSettings,
  email: string,
): Promise<{ ok: true }> {
  return request(settings, "/v1/auth/magic-link", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

export async function exchangeLoginToken(
  settings: WebSettings,
  token: string,
): Promise<SessionExchange> {
  return request(settings, "/v1/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

export async function fetchMe(settings: WebSettings): Promise<MeUser> {
  return request(settings, "/v1/me");
}

export async function logoutSession(settings: WebSettings): Promise<{ ok: true }> {
  return request(settings, "/v1/auth/logout", { method: "POST" });
}

export async function fetchJournal(
  settings: WebSettings,
  limit = 40,
): Promise<JournalEntry[]> {
  const data = await request<{ entries?: JournalEntry[] }>(
    settings,
    `/v1/operator/journal?limit=${encodeURIComponent(String(limit))}`,
  );
  return data.entries ?? [];
}

export async function fetchTrust(settings: WebSettings): Promise<TrustRecord[]> {
  const data = await request<{ records?: TrustRecord[] }>(settings, "/v1/operator/trust");
  return data.records ?? [];
}

/**
 * The response carries the whole database dump alongside `user` and `trust`;
 * the extra keys are the point, since this is the portability artefact.
 */
export async function exportAccount(settings: WebSettings): Promise<AccountExport> {
  return request(settings, "/v1/account/export");
}

/** `confirm` is required by the brain; erasure is a hard delete, not a flag. */
export async function deleteAccount(settings: WebSettings): Promise<{ ok: true }> {
  return request(settings, "/v1/account/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true }),
  });
}

export type AccountExport = {
  exportedAt: string;
  user: MeUser;
  journal?: JournalEntry[];
  trust?: TrustRecord[];
  [key: string]: unknown;
};

const CAPABILITY_KEYS: Record<string, string> = {
  "deploy.restart": "capabilities.deployRestart",
  "deploy.health": "capabilities.deployHealth",
  "deploy.logs": "capabilities.deployLogs",
  "code.draft_pr": "capabilities.codeDraftPr",
  "mail.draft": "capabilities.mailDraft",
  "mail.send": "capabilities.mailSend",
  "mail.thread": "capabilities.mailThread",
  "notify.escalate": "capabilities.notifyEscalate",
  "calendar.create": "capabilities.calendarCreate",
  "journal.log": "capabilities.journalLog",
  "payment.send": "capabilities.paymentSend",
  "filing.gst": "capabilities.filingGst",
  "filing.itr": "capabilities.filingItr",
  "gst.return": "capabilities.gstReturn",
  "tax.file": "capabilities.taxFile",
};

export function capabilityLabel(cap: string): string {
  const key = CAPABILITY_KEYS[cap];
  return key ? i18n.t(key) : i18n.t("capabilities.unknown", { id: cap });
}

export const KNOWN_CAPABILITIES: { id: string; flag: keyof AdapterFlags }[] = [
  { id: "mail.draft", flag: "mail" },
  { id: "mail.send", flag: "mail" },
  { id: "mail.thread", flag: "mail" },
  { id: "calendar.create", flag: "calendar" },
  { id: "code.draft_pr", flag: "github" },
  { id: "deploy.restart", flag: "render" },
  { id: "deploy.health", flag: "render" },
  { id: "notify.escalate", flag: "telegram" },
  { id: "journal.log", flag: "notify" },
];
