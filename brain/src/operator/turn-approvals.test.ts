import { describe, expect, it, vi } from "vitest";

import type { TurnBusEvent } from "@x/shared/dist/turns.js";

import { InMemoryApprovalsStore } from "./approvals.js";
import { InMemoryJournal } from "./journal.js";
import { InMemoryTrustLedger } from "./trust.js";
import { TurnEventHub } from "../runtime/turns/event-hub.js";
import {
  TURN_PERMISSION_PLAYBOOK_ID,
  attachTurnPermissionBridge,
  ingestTurnPermissionEvent,
  isTurnPermissionApproval,
  recordTurnPermission,
  resolveApprovalDecision,
  toolInputToArgs,
  turnPermissionActionId,
} from "./turn-approvals.js";

const now = () => new Date("2026-09-21T06:00:00.000Z");

function permissionSuspended(overrides: {
  turnId?: string;
  sessionId?: string | null;
  toolCallId?: string;
  toolName?: string;
  request?: { kind: string; toolName: string };
}): TurnBusEvent {
  const turnId = overrides.turnId ?? "turn-1";
  const toolCallId = overrides.toolCallId ?? "tc-1";
  return {
    turnId,
    sessionId: overrides.sessionId === undefined ? "session-1" : overrides.sessionId,
    event: {
      type: "turn_suspended",
      turnId,
      ts: "2026-09-21T06:00:00.000Z",
      pendingPermissions: [
        {
          toolCallId,
          toolName: overrides.toolName ?? "mail.send",
          request: overrides.request ?? { kind: "tool", toolName: "mail.send" },
        },
      ],
      pendingAsyncTools: [],
      usage: {},
    },
  } as TurnBusEvent;
}

describe("toolInputToArgs", () => {
  it("flattens nested arguments so preview fields sit at the top level", () => {
    expect(
      toolInputToArgs({
        toolkitSlug: "gmail",
        toolSlug: "GMAIL_SEND_EMAIL",
        arguments: { to: "a@b.com", subject: "Hi" },
      }),
    ).toMatchObject({ to: "a@b.com", subject: "Hi", toolkitSlug: "gmail" });
  });
});

describe("recordTurnPermission", () => {
  it("creates a pending approval with capability, args, and severity", async () => {
    const approvals = new InMemoryApprovalsStore({
      createId: () => "approval-turn-1",
      now: () => "2026-09-21T06:00:00.000Z",
    });
    const journal = new InMemoryJournal();

    const record = await recordTurnPermission(
      approvals,
      {
        sessionId: "session-1",
        turnId: "turn-1",
        toolCallId: "tc-1",
        toolName: "mail.send",
        input: { to: "mentor@example.com", subject: "Meeting at 12:30", body: "See you then." },
      },
      journal,
      now,
    );

    expect(record).toMatchObject({
      id: "approval-turn-1",
      actionId: turnPermissionActionId("turn-1", "tc-1"),
      playbookId: TURN_PERMISSION_PLAYBOOK_ID,
      capability: "mail.send",
      args: { to: "mentor@example.com", subject: "Meeting at 12:30", body: "See you then." },
      severity: "consequential",
      status: "pending",
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "tc-1",
    });
    await expect(approvals.listPending()).resolves.toEqual([record]);
    expect(journal.readAll()).toEqual([
      expect.objectContaining({
        kind: "outcome",
        playbookId: TURN_PERMISSION_PLAYBOOK_ID,
        data: expect.objectContaining({ status: "pending_approval", origin: "turn" }),
      }),
    ]);
    expect(isTurnPermissionApproval(record!)).toBe(true);
  });

  it("classifies an unknown tool name as irreversible", async () => {
    const approvals = new InMemoryApprovalsStore({ createId: () => "approval-turn-1" });
    const record = await recordTurnPermission(approvals, {
      turnId: "turn-1",
      toolCallId: "tc-1",
      toolName: "composio-execute",
      input: { toolkitSlug: "gmail" },
    });
    expect(record?.severity).toBe("irreversible");
  });

  it("does nothing when no approvals store is configured", async () => {
    const journal = new InMemoryJournal();
    await expect(
      recordTurnPermission(
        undefined,
        {
          turnId: "turn-1",
          toolCallId: "tc-1",
          toolName: "mail.send",
          input: { to: "a@b.com" },
        },
        journal,
        now,
      ),
    ).resolves.toBeUndefined();
    expect(journal.readAll()).toEqual([]);
  });

  it("does not mint a second card for the same tool call", async () => {
    const approvals = new InMemoryApprovalsStore({ createId: () => "approval-turn-1" });
    const first = await recordTurnPermission(approvals, {
      turnId: "turn-1",
      toolCallId: "tc-1",
      toolName: "mail.send",
      input: { to: "a@b.com" },
    });
    const second = await recordTurnPermission(approvals, {
      turnId: "turn-1",
      toolCallId: "tc-1",
      toolName: "mail.send",
      input: { to: "other@b.com" },
    });
    expect(second?.id).toBe(first?.id);
    await expect(approvals.listPending()).resolves.toHaveLength(1);
  });
});

describe("ingestTurnPermissionEvent", () => {
  it("creates an approval from a suspended turn using the live tool input", async () => {
    const approvals = new InMemoryApprovalsStore({
      createId: () => "approval-turn-1",
      now: () => "2026-09-21T06:00:00.000Z",
    });
    const created = await ingestTurnPermissionEvent(permissionSuspended({}), {
      approvals,
      getToolCall: async () => ({
        toolName: "mail.send",
        input: { to: "a@b.com", subject: "Meeting at 12:30" },
      }),
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      capability: "mail.send",
      args: { to: "a@b.com", subject: "Meeting at 12:30" },
      severity: "consequential",
      turnId: "turn-1",
      toolCallId: "tc-1",
      sessionId: "session-1",
    });
  });

  it("leaves today's behaviour unchanged when no store is configured", async () => {
    await expect(ingestTurnPermissionEvent(permissionSuspended({}), {})).resolves.toEqual([]);
  });

  it("ignores non-permission suspensions", async () => {
    const approvals = new InMemoryApprovalsStore({ createId: () => "approval-turn-1" });
    const created = await ingestTurnPermissionEvent(
      {
        turnId: "turn-1",
        sessionId: "session-1",
        event: {
          type: "turn_completed",
          turnId: "turn-1",
          ts: "2026-09-21T06:00:00.000Z",
          output: { role: "assistant", content: "done" },
          finishReason: "stop",
          usage: {},
        },
      } as TurnBusEvent,
      { approvals },
    );
    expect(created).toEqual([]);
    await expect(approvals.listPending()).resolves.toEqual([]);
  });

  it("attaches to the bus and records a pending card", async () => {
    const approvals = new InMemoryApprovalsStore({
      createId: () => "approval-turn-1",
      now: () => "2026-09-21T06:00:00.000Z",
    });
    const bus = new TurnEventHub();
    const unsubscribe = attachTurnPermissionBridge({
      bus,
      approvals,
      getToolCall: async () => ({ toolName: "mail.send", input: { to: "a@b.com" } }),
    });
    bus.publish(permissionSuspended({}));
    await vi.waitFor(async () => {
      expect(await approvals.listPending()).toHaveLength(1);
    });
    unsubscribe();
  });
});

describe("resolveApprovalDecision", () => {
  async function pendingTurn(approvals = new InMemoryApprovalsStore({ createId: () => "approval-turn-1" })) {
    const record = await recordTurnPermission(approvals, {
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "tc-1",
      toolName: "mail.send",
      input: { to: "a@b.com" },
    });
    return { approvals, record: record! };
  }

  it("approving resumes the turn with allow and credits trust after a successful tool result", async () => {
    const { approvals } = await pendingTurn();
    const journal = new InMemoryJournal();
    const ledger = new InMemoryTrustLedger({ now, createId: () => "row-1" });
    const resumeTurn = vi.fn(async () => undefined);
    const executeCapability = vi.fn(async () => ({ ok: true, capability: "mail.send" }));

    const result = await resolveApprovalDecision("approval-turn-1", "approve", {
      approvals,
      journal,
      executeCapability,
      resumeTurn,
      inspectTurnToolOutcome: async () => ({ ok: true }),
      trust: ledger,
      userId: "user-1",
      now,
    });

    expect(result.ok).toBe(true);
    expect(resumeTurn).toHaveBeenCalledOnce();
    expect(resumeTurn).toHaveBeenCalledWith("turn-1", "tc-1", "allow");
    expect(executeCapability).not.toHaveBeenCalled();
    await expect(
      ledger.get({ userId: "user-1", playbookId: TURN_PERMISSION_PLAYBOOK_ID, capability: "mail.send" }),
    ).resolves.toMatchObject({ streak: 1 });
  });

  it("denying resumes the turn with deny and resets trust", async () => {
    const { approvals } = await pendingTurn();
    const journal = new InMemoryJournal();
    const ledger = new InMemoryTrustLedger({ now });
    await ledger.recordApproval({
      userId: "user-1",
      playbookId: TURN_PERMISSION_PLAYBOOK_ID,
      capability: "mail.send",
    });
    const resumeTurn = vi.fn(async () => undefined);

    const result = await resolveApprovalDecision("approval-turn-1", "deny", {
      approvals,
      journal,
      executeCapability: async () => ({ ok: true, capability: "mail.send" }),
      resumeTurn,
      trust: ledger,
      userId: "user-1",
      now,
    });

    expect(result.ok).toBe(true);
    expect(resumeTurn).toHaveBeenCalledWith("turn-1", "tc-1", "deny");
    await expect(
      ledger.get({ userId: "user-1", playbookId: TURN_PERMISSION_PLAYBOOK_ID, capability: "mail.send" }),
    ).resolves.toMatchObject({ streak: 0 });
    expect(journal.readAll().some((entry) => entry.data.status === "denied")).toBe(true);
  });

  it("does not resume twice when resolve is replayed", async () => {
    const { approvals } = await pendingTurn();
    const journal = new InMemoryJournal();
    const resumeTurn = vi.fn(async () => undefined);
    const deps = {
      approvals,
      journal,
      executeCapability: async () => ({ ok: true, capability: "mail.send" }),
      resumeTurn,
      inspectTurnToolOutcome: async () => ({ ok: true }),
      now,
    };

    const first = await resolveApprovalDecision("approval-turn-1", "approve", deps);
    const replay = await resolveApprovalDecision("approval-turn-1", "approve", deps);

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(replay.execution).toBeNull();
    expect(resumeTurn).toHaveBeenCalledOnce();
  });

  it("does not retry a turn resume after a failed first deliver", async () => {
    const { approvals } = await pendingTurn();
    const resumeTurn = vi.fn(async () => {
      throw new Error("turn gone");
    });
    const deps = {
      approvals,
      journal: new InMemoryJournal(),
      executeCapability: async () => ({ ok: true, capability: "mail.send" }),
      resumeTurn,
      now,
    };

    const first = await resolveApprovalDecision("approval-turn-1", "approve", deps);
    resumeTurn.mockClear();
    const replay = await resolveApprovalDecision("approval-turn-1", "approve", deps);

    expect(first.ok).toBe(false);
    expect(first.error).toBe("turn gone");
    expect(replay.ok).toBe(true);
    expect(replay.execution).toBeNull();
    expect(resumeTurn).not.toHaveBeenCalled();
  });

  it("withholds trust credit when the turn tool result is not yet observable", async () => {
    const { approvals } = await pendingTurn();
    const ledger = new InMemoryTrustLedger({ now });
    const resumeTurn = vi.fn(async () => undefined);

    await resolveApprovalDecision("approval-turn-1", "approve", {
      approvals,
      journal: new InMemoryJournal(),
      executeCapability: async () => ({ ok: true, capability: "mail.send" }),
      resumeTurn,
      inspectTurnToolOutcome: async () => undefined,
      trust: ledger,
      userId: "user-1",
      now,
    });

    await expect(
      ledger.get({ userId: "user-1", playbookId: TURN_PERMISSION_PLAYBOOK_ID, capability: "mail.send" }),
    ).resolves.toBeUndefined();
  });

  it("leaves the operator webhook path executing the capability, not a turn", async () => {
    const approvals = new InMemoryApprovalsStore({
      createId: () => "approval-op-1",
      now: () => "2026-09-21T06:00:00.000Z",
    });
    await approvals.create({
      actionId: "act-1",
      playbookId: "inbox-draft",
      capability: "mail.draft",
      args: { to: "a@b.com" },
      signalId: "sig-1",
      severity: "reversible",
    });
    const executeCapability = vi.fn(async () => ({ ok: true, capability: "mail.draft" }));
    const resumeTurn = vi.fn(async () => undefined);
    const journal = new InMemoryJournal();
    const ledger = new InMemoryTrustLedger({ now });

    const first = await resolveApprovalDecision("approval-op-1", "approve", {
      approvals,
      journal,
      executeCapability,
      resumeTurn,
      trust: ledger,
      userId: "user-1",
      now,
    });
    const replay = await resolveApprovalDecision("approval-op-1", "approve", {
      approvals,
      journal,
      executeCapability,
      resumeTurn,
      trust: ledger,
      userId: "user-1",
      now,
    });

    expect(first).toMatchObject({ ok: true, execution: { ok: true, capability: "mail.draft" } });
    expect(resumeTurn).not.toHaveBeenCalled();
    expect(executeCapability).toHaveBeenCalledOnce();
    expect(executeCapability).toHaveBeenCalledWith(
      "mail.draft",
      { to: "a@b.com" },
      { signalId: "sig-1", playbookId: "inbox-draft" },
    );
    expect(replay.execution).toBeNull();
    expect(isTurnPermissionApproval(first.approval!)).toBe(false);
    await expect(
      ledger.get({ userId: "user-1", playbookId: "inbox-draft", capability: "mail.draft" }),
    ).resolves.toMatchObject({ streak: 1 });
  });

  it("does not execute a playbook capability when the click is a deny", async () => {
    const approvals = new InMemoryApprovalsStore({ createId: () => "approval-op-1" });
    await approvals.create({
      actionId: "act-1",
      playbookId: "inbox-draft",
      capability: "mail.draft",
      signalId: "sig-1",
    });
    const executeCapability = vi.fn(async () => ({ ok: true, capability: "mail.draft" }));

    await resolveApprovalDecision("approval-op-1", "deny", {
      approvals,
      journal: new InMemoryJournal(),
      executeCapability,
      resumeTurn: async () => undefined,
      now,
    });

    expect(executeCapability).not.toHaveBeenCalled();
  });
});
