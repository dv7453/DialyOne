export type TraceRedactMode = "strict" | "keys" | "off";

const REDACTED = "[redacted]";

const SECRET_KEYS = new Set([
    "password",
    "passwd",
    "secret",
    "token",
    "apikey",
    "api_key",
    "accesstoken",
    "access_token",
    "refreshtoken",
    "refresh_token",
    "idtoken",
    "id_token",
    "authorization",
    "auth",
    "bearer",
    "cookie",
    "cookies",
    "credential",
    "credentials",
    "privatekey",
    "private_key",
    "clientsecret",
    "client_secret",
    "xapikey",
    "x_api_key",
    "magictoken",
    "magic_token",
    "magiclink",
    "magic_link",
    "sessiontoken",
    "session_token",
    "setcookie",
    "set_cookie",
]);

const PII_KEYS = new Set([
    "body",
    "html",
    "text",
    "content",
    "message",
    "messages",
    "snippet",
    "transcript",
    "email",
    "raw",
    "rawemail",
    "raw_email",
    "to",
    "from",
    "cc",
    "bcc",
    "recipient",
    "recipients",
    "sender",
    "pan",
    "aadhaar",
    "aadhar",
    "gstin",
    "gst",
    "ifsc",
    "account",
    "accountnumber",
    "account_number",
    "accno",
    "card",
    "cardnumber",
    "card_number",
    "cvv",
    "uan",
    "invoice",
    "invoices",
    "financials",
    "salary",
    "tds",
    "turnover",
    "attachment",
    "attachments",
    "client",
    "clientname",
    "client_name",
    "payload",
]);

const KEEP_KEYS = new Set([
    "id",
    "ids",
    "sessionid",
    "session_id",
    "turnid",
    "turn_id",
    "userid",
    "user_id",
    "approvalid",
    "approval_id",
    "actionid",
    "action_id",
    "playbookid",
    "playbook_id",
    "signalid",
    "signal_id",
    "toolcallid",
    "tool_call_id",
    "toolid",
    "tool_id",
    "toolname",
    "tool_name",
    "capability",
    "status",
    "mode",
    "model",
    "provider",
    "severity",
    "class",
    "via",
    "origin",
    "kind",
    "name",
    "type",
    "ok",
    "required",
    "decision",
    "reason",
    "finishreason",
    "finish_reason",
    "inputtokens",
    "outputtokens",
    "totaltokens",
    "attempt",
    "attempts",
]);

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PAN_RE = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/;
const AADHAAR_RE = /\b\d{4}\s?\d{4}\s?\d{4}\b/;
const SECRET_VALUE_RE = /^(sk-|pk-lf-|sk-lf-|Bearer\s)/i;

const MAX_STRING = 500;

export function resolveTraceRedactMode(env: NodeJS.ProcessEnv = process.env): TraceRedactMode {
    const raw = (env.DIALY_TRACE_REDACT ?? "").trim().toLowerCase();
    if (raw === "keys" || raw === "off" || raw === "strict") {
        return raw;
    }
    return "strict";
}

export function redactForTrace(
    value: unknown,
    mode: TraceRedactMode = resolveTraceRedactMode(),
): unknown {
    return walk(value, mode, undefined, new WeakSet());
}

function walk(
    value: unknown,
    mode: TraceRedactMode,
    key: string | undefined,
    seen: WeakSet<object>,
): unknown {
    if (value == null || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (typeof value === "string") {
        return redactString(value, mode, key);
    }
    if (typeof value !== "object") {
        return REDACTED;
    }
    if (seen.has(value)) {
        return REDACTED;
    }
    seen.add(value);
    if (Array.isArray(value)) {
        return value.map((item) => walk(item, mode, key, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [rawKey, nested] of Object.entries(value as Record<string, unknown>)) {
        out[rawKey] = walk(nested, mode, rawKey, seen);
    }
    return out;
}

function redactString(value: string, mode: TraceRedactMode, key: string | undefined): string {
    const normalized = normalizeKey(key);
    if (normalized && KEEP_KEYS.has(normalized)) {
        return value;
    }
    if (normalized && isSecretKey(normalized)) {
        return redactedLen(value);
    }
    if (SECRET_VALUE_RE.test(value)) {
        return redactedLen(value);
    }
    if (mode === "strict") {
        if (normalized && PII_KEYS.has(normalized)) {
            return redactedLen(value);
        }
        if (EMAIL_RE.test(value) || PAN_RE.test(value) || AADHAAR_RE.test(value)) {
            return redactedLen(value);
        }
        if (value.length > MAX_STRING) {
            return `${REDACTED}:${value.length}`;
        }
    }
    return value;
}

function isSecretKey(normalized: string): boolean {
    if (SECRET_KEYS.has(normalized)) {
        return true;
    }
    if (normalized.endsWith("token") || normalized.endsWith("secret") || normalized.endsWith("password")) {
        return true;
    }
    if (normalized.includes("apikey") || normalized.includes("privatekey") || normalized.includes("magiclink")) {
        return true;
    }
    return false;
}

function normalizeKey(key: string | undefined): string | undefined {
    if (!key) {
        return undefined;
    }
    return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function redactedLen(value: string): string {
    return `${REDACTED}:${value.length}`;
}
