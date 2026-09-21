import { classifySeverity, type Severity } from "./severity.js";
import type { CreateApprovalInput } from "./approvals.js";

export const DEFAULT_APPROVAL_TTL_HOURS = {
  reversible: 48,
  consequential: 24,
  irreversible: 8,
} as const;

const HOUR_MS = 60 * 60 * 1000;

export function approvalTtlMs(severity: Severity, env: NodeJS.ProcessEnv = process.env): number {
  const specific = readHours(env, envNameFor(severity));
  if (specific !== undefined) {
    return specific * HOUR_MS;
  }
  const global = readHours(env, "DIALY_APPROVAL_TTL_HOURS");
  if (global !== undefined) {
    return global * HOUR_MS;
  }
  return DEFAULT_APPROVAL_TTL_HOURS[severity] * HOUR_MS;
}

export function approvalExpiresAt(
  nowIso: string,
  severity: Severity,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const start = Date.parse(nowIso);
  const base = Number.isFinite(start) ? start : Date.now();
  return new Date(base + approvalTtlMs(severity, env)).toISOString();
}

export function withDefaultExpiry(
  input: CreateApprovalInput,
  nowIso: string,
  env: NodeJS.ProcessEnv = process.env,
): CreateApprovalInput {
  if (input.expiresAt) {
    return input;
  }
  const severity = input.severity ?? classifySeverity(input.capability);
  return {
    ...input,
    severity,
    expiresAt: approvalExpiresAt(nowIso, severity, env),
  };
}

function envNameFor(severity: Severity): string {
  switch (severity) {
    case "reversible":
      return "DIALY_APPROVAL_TTL_REVERSIBLE_HOURS";
    case "consequential":
      return "DIALY_APPROVAL_TTL_CONSEQUENTIAL_HOURS";
    case "irreversible":
      return "DIALY_APPROVAL_TTL_IRREVERSIBLE_HOURS";
  }
}

function readHours(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return n;
}
