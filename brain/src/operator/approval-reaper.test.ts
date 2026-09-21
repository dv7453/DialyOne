import { describe, expect, it, vi } from "vitest";

import { InMemoryApprovalsStore } from "./approvals.js";
import { reapExpiredApprovals, startApprovalReaper } from "./approval-reaper.js";
import { InMemoryJournal } from "./journal.js";
import { InMemoryTrustLedger } from "./trust.js";
import { TURN_PERMISSION_PLAYBOOK_ID, recordTurnPermission } from "./turn-approvals.js";

const now = () => new Date("2026-09-21T12:00:00.000Z");

describe("reapExpiredApprovals", () => {
  it("expires overdue approvals, denies the waiting turn, and does not credit trust", async () => {
    let nowIso = "2026-09-21T00:00:00.000Z";
    const approvals = new InMemoryApprovalsStore({
      createId: () => "approval-turn-1",
      now: () => nowIso,
    });
    const record = await recordTurnPermission(approvals, {
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "tc-1",
      toolName: "mail.send",
      input: { to: "a@b.com", body: "send the invoice" },
    });
    expect(record?.status).toBe("pending");
    expect(record?.expiresAt).toBeTruthy();

    nowIso = "2026-09-23T00:00:00.000Z";
    const journal = new InMemoryJournal();
    const trust = new InMemoryTrustLedger({ now });
    await trust.recordApproval({
      userId: "user-1",
      playbookId: TURN_PERMISSION_PLAYBOOK_ID,
      capability: "mail.send",
    });
    const resumeTurn = vi.fn(async () => undefined);

    const first = await reapExpiredApprovals({
      approvals,
      journal,
      resumeTurn,
      trust,
      userId: "user-1",
      now,
    });
    const second = await reapExpiredApprovals({
      approvals,
      journal,
      resumeTurn,
      trust,
      userId: "user-1",
      now,
    });

    expect(first).toEqual({ expired: 1, turnsDenied: 1, resumeFailed: 0 });
    expect(second).toEqual({ expired: 0, turnsDenied: 0, resumeFailed: 0 });
    expect(resumeTurn).toHaveBeenCalledOnce();
    expect(resumeTurn).toHaveBeenCalledWith("turn-1", "tc-1", "deny");
    await expect(approvals.get("approval-turn-1")).resolves.toMatchObject({
      status: "expired",
      resolvedAt: "2026-09-23T00:00:00.000Z",
    });
    await expect(
      approvals.resolveTransition("approval-turn-1", "approve"),
    ).resolves.toMatchObject({ transitioned: false, record: { status: "expired" } });
    await expect(
      trust.get({ userId: "user-1", playbookId: TURN_PERMISSION_PLAYBOOK_ID, capability: "mail.send" }),
    ).resolves.toMatchObject({ streak: 0 });
    expect(journal.readAll().filter((entry) => entry.kind === "expired")).toHaveLength(1);
  });

  it("expires a playbook approval as a denial without executing the capability", async () => {
    let nowIso = "2026-09-21T00:00:00.000Z";
    const approvals = new InMemoryApprovalsStore({
      createId: () => "approval-op-1",
      now: () => nowIso,
    });
    await approvals.create({
      actionId: "act-1",
      playbookId: "inbox-draft",
      capability: "mail.send",
      args: { to: "a@b.com" },
      signalId: "sig-1",
      severity: "consequential",
    });
    nowIso = "2026-09-23T00:00:00.000Z";
    const resumeTurn = vi.fn(async () => undefined);
    const journal = new InMemoryJournal();
    const trust = new InMemoryTrustLedger({ now });
    await trust.recordApproval({
      userId: "user-1",
      playbookId: "inbox-draft",
      capability: "mail.send",
    });

    await reapExpiredApprovals({
      approvals,
      journal,
      resumeTurn,
      trust,
      userId: "user-1",
      now,
    });

    expect(resumeTurn).not.toHaveBeenCalled();
    await expect(
      trust.get({ userId: "user-1", playbookId: "inbox-draft", capability: "mail.send" }),
    ).resolves.toMatchObject({ streak: 0 });
    expect(
      journal.readAll().some((entry) => entry.kind === "expired" && entry.data.origin === "playbook"),
    ).toBe(true);
  });

  it("tells the user the request timed out rather than claiming they said no", async () => {
    let nowIso = "2026-09-21T00:00:00.000Z";
    const approvals = new InMemoryApprovalsStore({
      createId: () => "approval-op-2",
      now: () => nowIso,
    });
    await approvals.create({
      actionId: "act-1",
      playbookId: "inbox-draft",
      capability: "mail.send",
      args: { to: "a@b.com" },
      severity: "consequential",
    });
    nowIso = "2026-09-23T00:00:00.000Z";
    const journal = new InMemoryJournal();
    const trust = new InMemoryTrustLedger({ now });
    await trust.recordApproval({
      userId: "user-1",
      playbookId: "inbox-draft",
      capability: "mail.send",
    });

    await reapExpiredApprovals({ approvals, journal, trust, userId: "user-1", now });

    const reset = journal.readAll().find((entry) => entry.kind === "streak_reset");
    expect(reset?.data.cause).toBe("expired");
    expect(String(reset?.data.summary)).not.toContain("You said no");
    expect(String(reset?.data.summary)).toContain("Nobody answered");
  });

  it("startApprovalReaper returns a stop function and is idle when nothing is due", async () => {
    const approvals = new InMemoryApprovalsStore({ now: () => "2026-09-21T06:00:00.000Z" });
    await approvals.create({
      actionId: "act-1",
      playbookId: "inbox-draft",
      capability: "mail.draft",
      expiresAt: "2026-09-23T06:00:00.000Z",
    });
    const stop = startApprovalReaper(
      {
        approvals,
        journal: new InMemoryJournal(),
        now: () => new Date("2026-09-21T06:00:00.000Z"),
      },
      60_000,
    );
    stop();
    await expect(approvals.listPending()).resolves.toHaveLength(1);
  });
});
