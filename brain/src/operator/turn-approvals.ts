import type { TurnBusEvent } from "@x/shared/dist/turns.js";
import { reduceTurn } from "@x/shared/dist/turns.js";

import type {
  ApprovalRecord,
  ApprovalResolution,
  ApprovalsStore,
} from "./approvals.js";
import type { CapabilityResult } from "./capabilities/types.js";
import type { JournalWriter } from "./journal.js";
import { classifySeverity } from "./severity.js";
import { withDefaultExpiry } from "./expiry.js";
import {
  applyResolvedApprovalToTrust,
  type TrustLedger,
} from "./trust.js";
import type { ITurnEventBus } from "../runtime/turns/event-hub.js";
import type { ISessions } from "../runtime/sessions/api.js";
import { safeObserve } from "../observability/index.js";

// Turns have no playbook. A sentinel keeps ApprovalRecord.playbookId honest
// rather than minting a fake playbook id that trust rows would later confuse
// with authored YAML.
export const TURN_PERMISSION_PLAYBOOK_ID = "turn-permission";

export function turnPermissionActionId(turnId: string, toolCallId: string): string {
  return `turn:${turnId}:${toolCallId}`;
}

export function isTurnPermissionApproval(record: Pick<ApprovalRecord, "playbookId" | "turnId" | "toolCallId">): boolean {
  return record.playbookId === TURN_PERMISSION_PLAYBOOK_ID && Boolean(record.turnId && record.toolCallId);
}

export function toolInputToArgs(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const rec = input as Record<string, unknown>;
    const nested = rec.arguments;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      return { ...rec, ...(nested as Record<string, unknown>) };
    }
    return rec;
  }
  if (input === undefined) {
    return {};
  }
  return { input };
}

export type RecordTurnPermissionInput = {
  sessionId?: string | null;
  turnId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export async function recordTurnPermission(
  approvals: ApprovalsStore | undefined,
  input: RecordTurnPermissionInput,
  journal?: JournalWriter,
  now: () => Date = () => new Date(),
): Promise<ApprovalRecord | undefined> {
  if (!approvals) {
    return undefined;
  }

  return safeObserve(
    {
      name: "dialy.permission.required",
      sessionId: input.sessionId ?? undefined,
      turnId: input.turnId,
      input: {
        turnId: input.turnId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        args: toolInputToArgs(input.input),
      },
    },
    async (obs) => {
      const actionId = turnPermissionActionId(input.turnId, input.toolCallId);
      const existing = (await approvals.listPending()).find((record) => record.actionId === actionId);
      if (existing) {
        obs.update({ output: { approvalId: existing.id, reused: true } });
        return existing;
      }

      const args = toolInputToArgs(input.input);
      const record = await approvals.create(
        withDefaultExpiry(
          {
            actionId,
            playbookId: TURN_PERMISSION_PLAYBOOK_ID,
            capability: input.toolName,
            ...(Object.keys(args).length > 0 ? { args } : {}),
            severity: classifySeverity(input.toolName),
            turnId: input.turnId,
            toolCallId: input.toolCallId,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
          },
          now().toISOString(),
        ),
      );

      if (journal) {
        await journal.append({
          ts: now().toISOString(),
          kind: "outcome",
          playbookId: record.playbookId,
          data: {
            status: "pending_approval",
            origin: "turn",
            approval: record,
          },
        });
      }

      obs.update({
        output: {
          approvalId: record.id,
          expiresAt: record.expiresAt,
          severity: record.severity,
        },
      });
      return record;
    },
  );
}

export type IngestTurnPermissionDeps = {
  approvals?: ApprovalsStore;
  journal?: JournalWriter;
  now?: () => Date;
  getToolCall?: (turnId: string, toolCallId: string) => Promise<{ toolName: string; input: unknown } | undefined>;
};

export async function ingestTurnPermissionEvent(
  busEvent: TurnBusEvent,
  deps: IngestTurnPermissionDeps,
): Promise<ApprovalRecord[]> {
  if (!deps.approvals) {
    return [];
  }
  const event = busEvent.event;
  if (event.type !== "turn_suspended" || event.pendingPermissions.length === 0) {
    return [];
  }

  const created: ApprovalRecord[] = [];
  for (const pending of event.pendingPermissions) {
    let lookedUp: { toolName: string; input: unknown } | undefined;
    if (deps.getToolCall) {
      try {
        lookedUp = await deps.getToolCall(busEvent.turnId, pending.toolCallId);
      } catch {
        lookedUp = undefined;
      }
    }
    const record = await recordTurnPermission(
      deps.approvals,
      {
        sessionId: busEvent.sessionId,
        turnId: busEvent.turnId,
        toolCallId: pending.toolCallId,
        toolName: lookedUp?.toolName ?? pending.toolName,
        input: lookedUp?.input ?? pending.request,
      },
      deps.journal,
      deps.now,
    );
    if (record) {
      created.push(record);
    }
  }
  return created;
}

export function attachTurnPermissionBridge(opts: {
  bus: ITurnEventBus;
  approvals?: ApprovalsStore;
  journal?: JournalWriter;
  getToolCall?: IngestTurnPermissionDeps["getToolCall"];
  onError?: (message: string, meta?: Record<string, unknown>) => void;
}): () => void {
  if (!opts.approvals) {
    return () => undefined;
  }

  return opts.bus.subscribeAll((busEvent) => {
    void ingestTurnPermissionEvent(busEvent, {
      approvals: opts.approvals,
      journal: opts.journal,
      getToolCall: opts.getToolCall,
    }).catch((error) => {
      opts.onError?.("turn permission approval ingest failed", {
        turnId: busEvent.turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

export async function inspectTurnToolOutcome(
  sessions: Pick<ISessions, "getTurn">,
  turnId: string,
  toolCallId: string,
): Promise<{ ok: boolean } | undefined> {
  try {
    const turn = await sessions.getTurn(turnId);
    const state = reduceTurn(turn.events);
    const result = state.toolCalls.find((tc) => tc.toolCallId === toolCallId)?.result?.result;
    if (!result) {
      return undefined;
    }
    return { ok: !result.isError };
  } catch {
    return undefined;
  }
}

export type ResolveApprovalDeps = {
  approvals: ApprovalsStore;
  journal: JournalWriter;
  executeCapability: (
    capability: string,
    args: Record<string, unknown>,
    ctx: { signalId?: string; playbookId?: string },
  ) => Promise<CapabilityResult>;
  resumeTurn?: (
    turnId: string,
    toolCallId: string,
    decision: "allow" | "deny",
  ) => Promise<void>;
  inspectTurnToolOutcome?: (
    turnId: string,
    toolCallId: string,
  ) => Promise<{ ok: boolean } | undefined>;
  trust?: TrustLedger;
  userId?: string;
  now?: () => Date;
};

export type ResolveApprovalResult = {
  ok: boolean;
  approval?: ApprovalRecord;
  execution?: CapabilityResult | null;
  error?: string;
};

export async function resolveApprovalDecision(
  approvalId: string,
  decision: ApprovalResolution,
  deps: ResolveApprovalDeps,
): Promise<ResolveApprovalResult> {
  return safeObserve(
    {
      name: "dialy.approval.resolve",
      userId: deps.userId,
      input: { approvalId, decision },
    },
    async (obs) => {
      const result = await runResolveApprovalDecision(approvalId, decision, deps);
      obs.update({
        output: {
          ok: result.ok,
          approvalId: result.approval?.id,
          status: result.approval?.status,
          sessionId: result.approval?.sessionId,
          turnId: result.approval?.turnId,
          error: result.error,
        },
      });
      return result;
    },
  );
}

async function runResolveApprovalDecision(
  approvalId: string,
  decision: ApprovalResolution,
  deps: ResolveApprovalDeps,
): Promise<ResolveApprovalResult> {
  const now = deps.now ?? (() => new Date());
  try {
    const transition = await deps.approvals.resolveTransition(approvalId, decision);
    if (!transition) {
      return { ok: false, error: `approval not found: ${approvalId}` };
    }

    if (!transition.transitioned) {
      return { ok: true, approval: transition.record, execution: null };
    }

    const approval = transition.record;
    if (isTurnPermissionApproval(approval)) {
      return resolveTurnOriginated(approval, decision, deps, now);
    }
    return resolvePlaybookOriginated(approval, decision, deps, now);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveTurnOriginated(
  approval: ApprovalRecord,
  decision: ApprovalResolution,
  deps: ResolveApprovalDeps,
  now: () => Date,
): Promise<ResolveApprovalResult> {
  const turnId = approval.turnId;
  const toolCallId = approval.toolCallId;
  if (!turnId || !toolCallId) {
    return { ok: false, approval, error: "turn permission approval is missing turnId or toolCallId" };
  }
  if (!deps.resumeTurn) {
    return { ok: false, approval, error: "turn runtime is not available to resume this approval" };
  }

  try {
    await deps.resumeTurn(turnId, toolCallId, decision === "approve" ? "allow" : "deny");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.journal.append({
      ts: now().toISOString(),
      kind: "outcome",
      playbookId: approval.playbookId,
      data: { approval, origin: "turn", status: "resume_failed", error: message },
    });
    return { ok: false, approval, error: message };
  }

  if (decision === "deny") {
    await deps.journal.append({
      ts: now().toISOString(),
      kind: "outcome",
      playbookId: approval.playbookId,
      data: { approval, status: "denied", origin: "turn" },
    });
    await maybeApplyTrust(deps, approval, { decision: "deny" }, now);
    return { ok: true, approval, execution: null };
  }

  const observed = deps.inspectTurnToolOutcome
    ? await deps.inspectTurnToolOutcome(turnId, toolCallId)
    : undefined;

  await deps.journal.append({
    ts: now().toISOString(),
    kind: "outcome",
    playbookId: approval.playbookId,
    data: {
      approval,
      origin: "turn",
      status: observed ? (observed.ok ? "executed" : "failed") : "resumed",
      ...(observed ? { execution: observed } : { executionObserved: false }),
    },
  });

  if (observed) {
    await maybeApplyTrust(deps, approval, { decision: "approve", execution: observed }, now);
  }

  return {
    ok: true,
    approval,
    execution: observed
      ? { ok: observed.ok, capability: approval.capability }
      : null,
  };
}

async function resolvePlaybookOriginated(
  approval: ApprovalRecord,
  decision: ApprovalResolution,
  deps: ResolveApprovalDeps,
  now: () => Date,
): Promise<ResolveApprovalResult> {
  if (decision === "deny") {
    await deps.journal.append({
      ts: now().toISOString(),
      kind: "outcome",
      playbookId: approval.playbookId,
      signalId: approval.signalId,
      data: { approval, status: "denied" },
    });
    await maybeApplyTrust(deps, approval, { decision: "deny" }, now);
    return { ok: true, approval, execution: null };
  }

  const result = await deps.executeCapability(approval.capability, approval.args ?? {}, {
    signalId: approval.signalId,
    playbookId: approval.playbookId,
  });
  await deps.journal.append({
    ts: now().toISOString(),
    kind: "outcome",
    playbookId: approval.playbookId,
    signalId: approval.signalId,
    data: { approval, status: result.ok ? "executed" : "failed", result },
  });
  await maybeApplyTrust(deps, approval, { decision: "approve", execution: { ok: result.ok } }, now);
  return { ok: true, approval, execution: result };
}

async function maybeApplyTrust(
  deps: ResolveApprovalDeps,
  approval: ApprovalRecord,
  decision:
    | { decision: Extract<ApprovalResolution, "deny"> }
    | { decision: Extract<ApprovalResolution, "approve">; execution: { ok: boolean } },
  now: () => Date,
): Promise<void> {
  if (!deps.trust || !deps.userId) {
    return;
  }
  await applyResolvedApprovalToTrust(deps.trust, {
    userId: deps.userId,
    approval,
    journal: deps.journal,
    now,
    ...decision,
  });
}
