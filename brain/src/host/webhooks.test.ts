import crypto from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  FailureStreaks,
  TIMESTAMP_TOLERANCE_SEC,
  WebhookDeduper,
  normalizeGitHubEvent,
  normalizeRenderEvent,
  verifyGitHubSignature,
  verifyRenderSignature,
} from "./webhooks.js";

const RENDER_SECRET = "whsec_c2VjcmV0LXZhbHVlLWZvci10ZXN0cw==";
const NOW_SEC = 1_770_000_000;

function renderSignature(id: string, timestamp: string, body: string): string {
  const key = Buffer.from(RENDER_SECRET.slice("whsec_".length), "base64");
  return `v1,${crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

describe("verifyRenderSignature", () => {
  const id = "evt-123";
  const timestamp = String(NOW_SEC);
  const rawBody = JSON.stringify({ type: "deploy_ended", data: { status: "failed" } });

  it("accepts a correctly signed notification", () => {
    expect(
      verifyRenderSignature({
        secret: RENDER_SECRET,
        id,
        timestamp,
        signature: renderSignature(id, timestamp, rawBody),
        rawBody,
        nowSec: NOW_SEC,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    const result = verifyRenderSignature({
      secret: RENDER_SECRET,
      id,
      timestamp,
      signature: renderSignature(id, timestamp, rawBody),
      rawBody: `${rawBody} `,
      nowSec: NOW_SEC,
    });

    expect(result).toMatchObject({ ok: false });
  });

  it("rejects a stale timestamp to blunt replays", () => {
    const result = verifyRenderSignature({
      secret: RENDER_SECRET,
      id,
      timestamp,
      signature: renderSignature(id, timestamp, rawBody),
      rawBody,
      nowSec: NOW_SEC + TIMESTAMP_TOLERANCE_SEC + 1,
    });

    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("tolerance") });
  });

  it("rejects missing headers", () => {
    expect(verifyRenderSignature({ secret: RENDER_SECRET, rawBody, nowSec: NOW_SEC })).toMatchObject({ ok: false });
  });
});

describe("verifyGitHubSignature", () => {
  const secret = "github-secret";
  const rawBody = JSON.stringify({ action: "completed" });
  const signature = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;

  it("accepts a correctly signed delivery", () => {
    expect(verifyGitHubSignature(secret, signature, rawBody)).toEqual({ ok: true });
  });

  it("rejects a wrong signature", () => {
    expect(verifyGitHubSignature(secret, "sha256=deadbeef", rawBody)).toMatchObject({ ok: false });
  });

  it("rejects a missing header", () => {
    expect(verifyGitHubSignature(secret, undefined, rawBody)).toMatchObject({ ok: false });
  });
});

describe("normalizeRenderEvent", () => {
  it("maps a failed deploy onto the playbook vocabulary", () => {
    const result = normalizeRenderEvent({
      type: "deploy_ended",
      timestamp: "2026-01-01T00:00:00Z",
      data: { id: "evt-1", serviceId: "srv-1", status: "failed" },
    });

    expect(result).toMatchObject({
      source: "render",
      type: "deploy.failed",
      failed: true,
      dedupeKey: "evt-1",
      payload: { event: "deploy.failed", serviceId: "srv-1", status: "failed" },
    });
  });

  it("maps server_failed onto service.unhealthy", () => {
    expect(normalizeRenderEvent({ type: "server_failed", data: { id: "evt-2", serviceId: "srv-1" } })).toMatchObject({
      type: "service.unhealthy",
      failed: true,
    });
  });

  it("marks a successful deploy as resolved so triage can ignore it", () => {
    expect(normalizeRenderEvent({ type: "deploy_ended", data: { status: "succeeded", serviceId: "srv-1" } })).toMatchObject({
      type: "deploy.succeeded",
      failed: false,
      payload: { resolved: true },
    });
  });

  it("ignores events with no operator meaning", () => {
    expect(normalizeRenderEvent({ type: "deploy_started", data: { serviceId: "srv-1" } })).toBeNull();
    expect(normalizeRenderEvent({})).toBeNull();
  });
});

describe("normalizeGitHubEvent", () => {
  const repository = { full_name: "acme/api" };

  it("maps a failed workflow run onto ci.failed", () => {
    const result = normalizeGitHubEvent("workflow_run", {
      repository,
      workflow_run: { id: 99, conclusion: "failure", head_branch: "main", name: "CI", html_url: "https://x" },
    });

    expect(result).toMatchObject({
      source: "github",
      type: "ci.failed",
      failed: true,
      payload: { event: "ci.failed", repo: "acme/api", branch: "main" },
    });
  });

  it("treats a timed-out check run as a failure", () => {
    expect(normalizeGitHubEvent("check_run", { repository, check_run: { id: 1, conclusion: "timed_out" } })).toMatchObject({
      type: "ci.failed",
      failed: true,
    });
  });

  it("marks a green run as resolved", () => {
    expect(normalizeGitHubEvent("workflow_run", { repository, workflow_run: { id: 2, conclusion: "success" } })).toMatchObject({
      type: "ci.passed",
      failed: false,
      payload: { resolved: true },
    });
  });

  it("ignores unrelated events and in-flight runs", () => {
    expect(normalizeGitHubEvent("push", { repository })).toBeNull();
    expect(normalizeGitHubEvent("workflow_run", { repository, workflow_run: { id: 3, conclusion: null } })).toBeNull();
  });
});

describe("FailureStreaks", () => {
  it("counts consecutive failures per subject and resets on recovery", () => {
    const streaks = new FailureStreaks();

    expect(streaks.record("srv-1", true)).toBe(1);
    expect(streaks.record("srv-1", true)).toBe(2);
    expect(streaks.record("srv-2", true)).toBe(1);
    expect(streaks.record("srv-1", false)).toBe(0);
    expect(streaks.record("srv-1", true)).toBe(1);
  });
});

describe("WebhookDeduper", () => {
  it("suppresses a repeated delivery id within the ttl", () => {
    let clock = 0;
    const deduper = new WebhookDeduper(1000, () => clock);

    expect(deduper.isDuplicate("evt-1")).toBe(false);
    expect(deduper.isDuplicate("evt-1")).toBe(true);

    clock = 2000;
    expect(deduper.isDuplicate("evt-1")).toBe(false);
  });

  it("never suppresses an unidentified delivery", () => {
    const deduper = new WebhookDeduper();
    expect(deduper.isDuplicate(undefined)).toBe(false);
    expect(deduper.isDuplicate(undefined)).toBe(false);
  });
});
