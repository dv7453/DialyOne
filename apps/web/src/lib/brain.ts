import type {
  AdapterFlags,
  ApprovalRecord,
  ChatAttachment,
  ResolvedApproval,
} from "../types";
import type { WebSettings } from "./settings";

export type ChatResponse = {
  sessionId: string;
  turnId: string;
  status: "completed" | "failed" | "cancelled" | "ask_human" | "suspended" | "timeout";
  text: string | null;
  error?: string;
  askHuman?: { toolCallId: string; query: string; options?: string[] };
};

function headers(settings: WebSettings): HeadersInit {
  const h: Record<string, string> = {
    Accept: "application/json",
  };
  if (settings.brainToken.trim()) {
    h.Authorization = `Bearer ${settings.brainToken.trim()}`;
  }
  return h;
}

async function request<T>(settings: WebSettings, path: string, init?: RequestInit): Promise<T> {
  const url = `${settings.brainUrl}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...headers(settings),
      ...(init?.headers ?? {}),
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
    const err = body as { message?: string; error?: string };
    throw new Error(err.message ?? err.error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export async function fetchHealth(settings: WebSettings): Promise<{ bootOk?: boolean }> {
  return request(settings, "/health");
}

export async function fetchCapabilities(settings: WebSettings): Promise<{ flags: AdapterFlags }> {
  return request(settings, "/v1/operator/capabilities");
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
      summary = "Draft prepared (dry run — nothing sent).";
    } else if (exec.ok) {
      summary = "Approved and executed.";
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

export function capabilityLabel(cap: string): string {
  const map: Record<string, string> = {
    "deploy.restart": "Restart Render service",
    "code.draft_pr": "Draft pull request",
    "mail.draft": "Draft email reply",
    "notify.escalate": "Escalate to you",
  };
  return map[cap] ?? cap;
}
