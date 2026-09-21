/**
 * Inbound webhook ingress for the operator.
 *
 * Webhook senders cannot present BRAIN_TOKEN, so these routes authenticate by
 * HMAC signature instead. Render follows the Standard Webhooks scheme; GitHub
 * uses its own `X-Hub-Signature-256` header.
 *
 * Vendor event vocabularies are normalized here, at the edge, so playbooks keep
 * matching on stable names like `deploy.failed` and `ci.failed`.
 */
import crypto from "node:crypto";

export type WebhookVerification = { ok: true } | { ok: false; reason: string };

/** Reject notifications older than this to blunt replay attempts. */
export const TIMESTAMP_TOLERANCE_SEC = 5 * 60;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function hmacBase64(key: Buffer | string, message: string): string {
  return crypto.createHmac("sha256", key).update(message, "utf8").digest("base64");
}

function decodeSecret(secret: string): Buffer {
  const bare = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const decoded = Buffer.from(bare, "base64");
  // A base64 round-trip that survives intact means the secret really was
  // base64; otherwise treat it as raw bytes.
  return decoded.length > 0 && decoded.toString("base64").replace(/=+$/, "") === bare.replace(/=+$/, "")
    ? decoded
    : Buffer.from(bare, "utf8");
}

function parseSignatureHeader(header: string): string[] {
  return header
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [version, value] = part.split(",");
      return value && version.startsWith("v") ? value : part;
    });
}

export type RenderSignatureInput = {
  secret: string;
  id?: string;
  timestamp?: string;
  signature?: string;
  rawBody: string;
  nowSec?: number;
};

export function verifyRenderSignature(input: RenderSignatureInput): WebhookVerification {
  const { secret, id, timestamp, signature, rawBody } = input;
  if (!id || !timestamp || !signature) {
    return { ok: false, reason: "missing webhook-id, webhook-timestamp or webhook-signature header" };
  }

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) {
    return { ok: false, reason: "webhook-timestamp is not a unix timestamp" };
  }

  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - sentAt) > TIMESTAMP_TOLERANCE_SEC) {
    return { ok: false, reason: "webhook-timestamp is outside the accepted tolerance" };
  }

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  // Render documents the signed string as including the secret, but also
  // states that Standard Webhooks client libraries validate its notifications.
  // Both derivations require the secret, so accepting either is safe.
  const candidates = [
    hmacBase64(decodeSecret(secret), signedContent),
    hmacBase64(secret, `${signedContent}.${secret}`),
  ];

  const provided = parseSignatureHeader(signature);
  const matched = provided.some((value) => candidates.some((candidate) => safeEqual(value, candidate)));
  return matched ? { ok: true } : { ok: false, reason: "webhook signature did not match" };
}

export function verifyGitHubSignature(secret: string, header: string | undefined, rawBody: string): WebhookVerification {
  if (!header) {
    return { ok: false, reason: "missing x-hub-signature-256 header" };
  }

  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
  return safeEqual(header, expected) ? { ok: true } : { ok: false, reason: "webhook signature did not match" };
}

export type NormalizedWebhook = {
  source: string;
  type: string;
  payload: Record<string, unknown>;
  /** Present when the event represents a failure worth counting. */
  failed: boolean;
  dedupeKey?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * Render sends `deploy_ended` / `server_failed` with a separate status field.
 * Playbooks match `deploy.failed` and `service.unhealthy`.
 */
export function normalizeRenderEvent(raw: unknown): NormalizedWebhook | null {
  const body = asRecord(raw);
  const renderEvent = asString(body.type);
  if (!renderEvent) {
    return null;
  }

  const data = asRecord(body.data);
  const serviceId = asString(data.serviceId) ?? asString(body.serviceId);
  const status = asString(data.status);
  const eventId = asString(data.id) ?? asString(body.id);

  const base = {
    source: "render",
    payload: {
      renderEvent,
      serviceId,
      status,
      eventId,
      occurredAt: asString(body.timestamp),
    } as Record<string, unknown>,
    dedupeKey: eventId,
  };

  if (renderEvent === "server_failed") {
    return {
      ...base,
      type: "service.unhealthy",
      failed: true,
      payload: { ...base.payload, event: "service.unhealthy", reason: asString(asRecord(body.details).reason) },
    };
  }

  if (status === "failed") {
    return {
      ...base,
      type: "deploy.failed",
      failed: true,
      payload: { ...base.payload, event: "deploy.failed" },
    };
  }

  if (status === "succeeded") {
    return {
      ...base,
      type: "deploy.succeeded",
      failed: false,
      payload: { ...base.payload, event: "deploy.succeeded", resolved: true },
    };
  }

  return null;
}

const GITHUB_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

export function normalizeGitHubEvent(event: string | undefined, raw: unknown): NormalizedWebhook | null {
  const body = asRecord(raw);
  const run = event === "workflow_run" ? asRecord(body.workflow_run) : event === "check_run" ? asRecord(body.check_run) : null;
  if (!run) {
    return null;
  }

  const conclusion = asString(run.conclusion);
  if (!conclusion) {
    return null;
  }

  const repository = asRecord(body.repository);
  const payload: Record<string, unknown> = {
    githubEvent: event,
    conclusion,
    repo: asString(repository.full_name),
    branch: asString(run.head_branch),
    name: asString(run.name),
    runUrl: asString(run.html_url),
    runId: run.id,
  };

  if (GITHUB_FAILURE_CONCLUSIONS.has(conclusion)) {
    return {
      source: "github",
      type: "ci.failed",
      failed: true,
      payload: { ...payload, event: "ci.failed" },
      dedupeKey: run.id === undefined ? undefined : `github-${event}-${String(run.id)}-${conclusion}`,
    };
  }

  if (conclusion === "success") {
    return {
      source: "github",
      type: "ci.passed",
      failed: false,
      payload: { ...payload, event: "ci.passed", resolved: true },
      dedupeKey: run.id === undefined ? undefined : `github-${event}-${String(run.id)}-${conclusion}`,
    };
  }

  return null;
}

/**
 * Tracks consecutive failures per subject so playbooks can distinguish a first
 * blip (`attempt < 2` → minor) from a repeated failure that needs a human.
 */
export class FailureStreaks {
  private readonly streaks = new Map<string, number>();

  record(subject: string | undefined, failed: boolean): number {
    const key = subject ?? "default";
    if (!failed) {
      this.streaks.delete(key);
      return 0;
    }

    const next = (this.streaks.get(key) ?? 0) + 1;
    this.streaks.set(key, next);
    return next;
  }
}

/** Remembers recently handled delivery ids so vendor retries are not replayed. */
export class WebhookDeduper {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  isDuplicate(key: string | undefined): boolean {
    if (!key) {
      return false;
    }

    const current = this.now();
    for (const [seenKey, at] of this.seen) {
      if (current - at > this.ttlMs) {
        this.seen.delete(seenKey);
      }
    }

    if (this.seen.has(key)) {
      return true;
    }

    this.seen.set(key, current);
    return false;
  }
}
