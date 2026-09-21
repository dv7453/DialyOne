export type ApprovalRecord = {
  id: string;
  actionId: string;
  playbookId: string;
  capability: string;
  args?: Record<string, unknown>;
  signalId?: string;
  status: "pending" | "approved" | "denied" | "expired";
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
