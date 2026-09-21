import type { Severity } from "./lib/severity";

export type { Severity };

export type ApprovalRecord = {
  id: string;
  actionId: string;
  playbookId: string;
  capability: string;
  args?: Record<string, unknown>;
  signalId?: string;
  status: "pending" | "approved" | "denied" | "expired";
  severity?: Severity;
  createdAt: string;
  resolvedAt?: string;
};

export type AdapterFlags = {
  render: boolean;
  github: boolean;
  mail: boolean;
  calendar: boolean;
  notify: boolean;
  telegram: boolean;
};

export type ChatAttachment = {
  name: string;
  mimeType?: string;
  text?: string;
  summary?: string;
};

export type ChatMessage = {
  id: string;
  role: "user" | "dialy" | "system";
  text: string;
  at: string;
  attachment?: ChatAttachment;
};

export type ResolvedApproval = {
  approval: ApprovalRecord;
  decision: "approve" | "deny";
  ok: boolean;
  summary?: string;
};

export type AskHumanState = {
  sessionId: string;
  turnId: string;
  toolCallId: string;
  query: string;
  options?: string[];
};

export type VoicePhase = "idle" | "listening" | "thinking" | "speaking";

export type MeUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  locale: string;
  auth: "session" | "static_token";
};

export type SessionExchange = {
  token: string;
  expiresAt: string;
  user: {
    id: string;
    email: string | null;
    displayName: string | null;
    locale: string;
  };
};

export type OperatorAdapterStatus = {
  id: string;
  capabilities: string[];
  available: boolean;
};

export type OperatorCapabilities = {
  adapters: OperatorAdapterStatus[];
  flags: AdapterFlags;
};

export type PlaybookSummary = {
  id: string;
  title: string;
  enabled: boolean;
};

export type JournalEntry = {
  ts: string;
  kind: string;
  playbookId?: string;
  signalId?: string;
  data: Record<string, unknown>;
};

export type TrustRecord = {
  id: string;
  userId: string;
  playbookId: string;
  capability: string;
  severity: Severity;
  streak: number;
  autonomyGranted: boolean;
  updatedAt: string;
};

