export const APPROVAL_FACT_KEYS = [
  "to",
  "cc",
  "from",
  "subject",
  "body",
  "amount",
  "period",
  "gstin",
  "pan",
  "form",
  "recipient",
  "title",
  "description",
  "account",
  "ifsc",
  "branch",
  "filename",
  "year",
  "quarter",
  "returnType",
  "client",
  "notice",
  "dueDate",
] as const;

export type ApprovalFactKey = (typeof APPROVAL_FACT_KEYS)[number];

export type ApprovalFact = {
  key: ApprovalFactKey;
  value: string;
};

const ALIASES: Record<string, ApprovalFactKey> = {
  text: "body",
  html: "body",
  summary: "description",
  file: "filename",
  fileName: "filename",
  return_type: "returnType",
  due_date: "dueDate",
  gstin_uin: "gstin",
};

const BODY_KEYS = new Set<ApprovalFactKey>(["body", "description", "notice"]);
const MAX_BODY = 360;

function stringifyArg(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => stringifyArg(item))
      .filter((item): item is string => Boolean(item));
    return parts.length ? parts.join(", ") : undefined;
  }
  return undefined;
}

function clip(key: ApprovalFactKey, value: string): string {
  if (!BODY_KEYS.has(key) || value.length <= MAX_BODY) return value;
  return `${value.slice(0, MAX_BODY).trimEnd()}…`;
}

export function approvalFacts(args?: Record<string, unknown>): ApprovalFact[] {
  if (!args) return [];
  const seen = new Set<ApprovalFactKey>();
  const facts: ApprovalFact[] = [];

  const consider = (rawKey: string, value: unknown) => {
    const mapped = (APPROVAL_FACT_KEYS as readonly string[]).includes(rawKey)
      ? (rawKey as ApprovalFactKey)
      : ALIASES[rawKey];
    if (!mapped || seen.has(mapped)) return;
    const text = stringifyArg(value);
    if (!text) return;
    seen.add(mapped);
    facts.push({ key: mapped, value: clip(mapped, text) });
  };

  for (const key of APPROVAL_FACT_KEYS) {
    consider(key, args[key]);
  }
  for (const [key, value] of Object.entries(args)) {
    consider(key, value);
  }
  return facts;
}
