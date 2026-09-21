import { isSpendExceededError } from "./budget.js";
import type { CapabilityResult } from "./capabilities/types.js";

export type FailureClass = "retryable" | "terminal";

export const RETRY_BASE_MS = 1000;
export const RETRY_FACTOR = 2;
export const RETRY_MAX_DELAY_MS = 60_000;
export const RETRY_JITTER_RATIO = 0.2;
export const DEFAULT_MAX_ATTEMPTS = 5;

const NETWORK_ERRNO = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const NETWORK_PHRASES = [
  "socket hang up",
  "socket hangup",
  "network error",
  "network timeout",
  "failed to fetch",
  "fetch failed",
  "temporarily unavailable",
  "econnreset",
  "etimedout",
  "enotfound",
  "econnrefused",
];

const RATE_LIMIT_PHRASES = [
  "rate limit",
  "rate-limit",
  "ratelimit",
  "too many requests",
  "retry-after",
  "retry after",
  "throttl",
];

export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const exponential = RETRY_BASE_MS * RETRY_FACTOR ** (n - 1);
  const capped = Math.min(exponential, RETRY_MAX_DELAY_MS);
  const jitter = capped * RETRY_JITTER_RATIO * clamp01(random());
  return Math.round(capped + jitter);
}

/**
 * Unclassifiable failures are terminal: retrying a bad request forever
 * helps nobody, and a dropped-then-replayed 400 is worse than a logged miss.
 */
export function classifyFailure(input: CapabilityResult | unknown): FailureClass {
  if (isBudgetFailure(input)) {
    return "terminal";
  }
  if (isCapabilityResult(input)) {
    if (input.ok) {
      return "terminal";
    }
    return classifyParts(collectParts(input.error, input.data));
  }
  return classifyParts(collectParts(input, undefined));
}

function isBudgetFailure(input: unknown): boolean {
  if (isSpendExceededError(input)) {
    return true;
  }
  if (isCapabilityResult(input)) {
    return isBudgetFailure(input.data) || isBudgetFailureText(input.error);
  }
  if (input instanceof Error) {
    if (input.name === "SpendExceededError") {
      return true;
    }
    if (isBudgetFailureText(errorText(input))) {
      return true;
    }
    return input.cause != null && isBudgetFailure(input.cause);
  }
  if (typeof input === "string") {
    return isBudgetFailureText(input);
  }
  return false;
}

function isBudgetFailureText(text: string | undefined): boolean {
  if (!text) {
    return false;
  }
  const lower = text.toLowerCase();
  return lower.includes("daily spend cap reached") || lower.includes("spendexceedederror");
}

export function errorText(error: unknown, depth = 0): string {
  if (error == null) {
    return "";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    const code = errnoOf(error);
    const head = code && !error.message.includes(code) ? `${code} ${error.message}` : error.message;
    if (depth >= 3 || error.cause == null) {
      return head;
    }
    const cause = errorText(error.cause, depth + 1);
    return cause && cause !== head ? `${head}; ${cause}` : head;
  }
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : undefined;
    const message =
      typeof record.message === "string"
        ? record.message
        : typeof record.error === "string"
          ? record.error
          : "";
    const head = [code, message].filter(Boolean).join(" ");
    if (head) {
      return head;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

function classifyParts(parts: { text: string; status?: number; code?: string }): FailureClass {
  if (parts.code && NETWORK_ERRNO.has(parts.code)) {
    return "retryable";
  }

  const status = parts.status ?? extractHttpStatus(parts.text);
  if (status !== undefined) {
    return isRetryableStatus(status) ? "retryable" : "terminal";
  }

  const lower = parts.text.toLowerCase();
  if (RATE_LIMIT_PHRASES.some((phrase) => lower.includes(phrase))) {
    return "retryable";
  }
  if (NETWORK_PHRASES.some((phrase) => lower.includes(phrase))) {
    return "retryable";
  }
  if (NETWORK_ERRNO.has(parts.text.toUpperCase())) {
    return "retryable";
  }

  return "terminal";
}

function collectParts(error: unknown, data: unknown): { text: string; status?: number; code?: string } {
  const fromError = inspectValue(error, 0);
  const fromData = inspectValue(data, 0);
  const text = [fromError.text, fromData.text].filter(Boolean).join(" ");
  return {
    text,
    status: fromError.status ?? fromData.status,
    code: fromError.code ?? fromData.code,
  };
}

function inspectValue(value: unknown, depth: number): { text: string; status?: number; code?: string } {
  if (value == null || depth > 3) {
    return { text: "" };
  }

  if (typeof value === "number" && isHttpStatus(value)) {
    return { text: "", status: value };
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return { text: String(value), code: errnoToken(String(value)), status: extractHttpStatus(String(value)) };
  }

  if (value instanceof Error) {
    const nested = value.cause != null ? inspectValue(value.cause, depth + 1) : { text: "" };
    const status = numericStatus(value) ?? nested.status;
    const code = errnoOf(value) ?? nested.code;
    return {
      text: [errorText(value, depth), nested.text].filter(Boolean).join(" "),
      status,
      code,
    };
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const nested =
      record.response != null
        ? inspectValue(record.response, depth + 1)
        : record.cause != null
          ? inspectValue(record.cause, depth + 1)
          : { text: "" };
    const status = numericStatus(record) ?? nested.status;
    const code = typeof record.code === "string" ? record.code : nested.code;
    return {
      text: [errorText(value, depth), nested.text].filter(Boolean).join(" "),
      status,
      code,
    };
  }

  return { text: String(value) };
}

function numericStatus(value: unknown): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value === "number") {
    return isHttpStatus(value) ? value : undefined;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["status", "statusCode", "httpStatus", "status_code"]) {
    const candidate = record[key];
    if (typeof candidate === "number" && isHttpStatus(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
      const parsed = Number(candidate);
      if (isHttpStatus(parsed)) {
        return parsed;
      }
    }
  }
  if (record.response && typeof record.response === "object") {
    return numericStatus(record.response);
  }
  return undefined;
}

function extractHttpStatus(text: string): number | undefined {
  if (!text) {
    return undefined;
  }

  const patterns = [
    /\bHTTP\/\d+(?:\.\d+)?\s+([1-5]\d{2})\b/i,
    /\bHTTP\s+([1-5]\d{2})\b/i,
    /\bstatus(?:[_\s-]?code)?\s*[:=]?\s*([1-5]\d{2})\b/i,
    /["']status(?:Code)?["']\s*:\s*([1-5]\d{2})/,
    /\b(408|429|5\d{2})\b/,
    /\b(4\d{2})\s+(?:Unauthorized|Forbidden|Not Found|Bad Request|Conflict|Unprocessable|Method Not Allowed|Unsupported|Gone|Too Many|Request Timeout|Precondition|Payload)\b/i,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) {
      continue;
    }
    const status = Number(match[1]);
    if (isHttpStatus(status)) {
      return status;
    }
  }

  return undefined;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function isHttpStatus(value: number): boolean {
  return Number.isInteger(value) && value >= 400 && value <= 599;
}

function errnoOf(error: object): string | undefined {
  if (!("code" in error) || typeof (error as { code?: unknown }).code !== "string") {
    return undefined;
  }
  return (error as { code: string }).code;
}

function errnoToken(text: string): string | undefined {
  const match = /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|EPIPE|ENETUNREACH|EHOSTUNREACH|ECONNABORTED)\b/i.exec(
    text,
  );
  return match ? match[1].toUpperCase() : undefined;
}

function isCapabilityResult(value: unknown): value is CapabilityResult {
  return (
    !!value &&
    typeof value === "object" &&
    "ok" in value &&
    "capability" in value &&
    typeof (value as CapabilityResult).ok === "boolean" &&
    typeof (value as CapabilityResult).capability === "string"
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
