import type { ApprovalsStore, ApprovalRecord } from "./approvals.js";
import type { CapabilityRegistry } from "./capabilities/registry.js";
import type { CapabilityResult } from "./capabilities/types.js";
import type { EngineResult } from "./engine.js";
import type { JournalWriter } from "./journal.js";
import type { ActionRequest, PolicyMode } from "./types.js";

export type ExecutionStatus = "skipped" | "pending_approval" | "executed" | "failed";

export type ExecutionRecord = {
  actionId: string;
  playbookId: string;
  capability: string;
  mode: PolicyMode;
  status: ExecutionStatus;
  result?: CapabilityResult;
  approval?: ApprovalRecord;
};

export type ExecutionSummary = {
  signalId: string;
  actions: ExecutionRecord[];
};

function nowIso(): string {
  return new Date().toISOString();
}

export async function executeEngineResult(
  result: EngineResult,
  registry: CapabilityRegistry,
  approvals: ApprovalsStore,
  journal: JournalWriter,
): Promise<ExecutionSummary> {
  const records: ExecutionRecord[] = [];

  for (const match of result.matches) {
    for (const action of match.actions) {
      const record = await executeAction(action, registry, approvals, journal);
      records.push(record);
    }
  }

  return {
    signalId: result.signalId,
    actions: records,
  };
}

async function executeAction(
  action: ActionRequest,
  registry: CapabilityRegistry,
  approvals: ApprovalsStore,
  journal: JournalWriter,
): Promise<ExecutionRecord> {
  if (action.mode === "log") {
    const record: ExecutionRecord = baseRecord(action, "skipped");
    await appendOutcome(journal, action, { status: record.status, reason: "Log-mode action recorded without execution." });
    return record;
  }

  if (action.mode === "approve") {
    const approval = await approvals.create({
      actionId: action.id,
      playbookId: action.playbookId,
      capability: action.capability,
      args: action.args,
      signalId: action.signalId,
    });
    const record: ExecutionRecord = { ...baseRecord(action, "pending_approval"), approval };
    await appendOutcome(journal, action, { status: record.status, approval });
    return record;
  }

  if (action.mode === "escalate") {
    const result = await registry.execute(
      "notify.escalate",
      {
        title: `Operator escalation: ${action.capability}`,
        body: JSON.stringify({ action }, null, 2),
        action,
        args: action.args ?? {},
      },
      { signalId: action.signalId, playbookId: action.playbookId },
    );
    const status = result.ok ? "executed" : "failed";
    const record: ExecutionRecord = { ...baseRecord(action, status), result };
    await journal.append({
      ts: nowIso(),
      kind: "escalate",
      playbookId: action.playbookId,
      signalId: action.signalId,
      data: { action, result },
    });
    await appendOutcome(journal, action, { status, result });
    return record;
  }

  const executeArgs =
    action.capability === "notify.escalate"
      ? {
          title: `Dialy escalate: ${action.playbookId}`,
          body: [
            `signal: ${action.signalId}`,
            `capability: ${action.capability}`,
            `mode: ${action.mode}`,
            action.args && Object.keys(action.args).length
              ? `args: ${JSON.stringify(action.args)}`
              : null,
          ]
            .filter(Boolean)
            .join("\n"),
          ...(action.args ?? {}),
        }
      : (action.args ?? {});

  const result = await registry.execute(action.capability, executeArgs, {
    signalId: action.signalId,
    playbookId: action.playbookId,
  });
  const status = result.ok ? "executed" : "failed";
  const record: ExecutionRecord = { ...baseRecord(action, status), result };
  await appendOutcome(journal, action, { status, result });
  return record;
}

function baseRecord(action: ActionRequest, status: ExecutionStatus): ExecutionRecord {
  return {
    actionId: action.id,
    playbookId: action.playbookId,
    capability: action.capability,
    mode: action.mode,
    status,
  };
}

async function appendOutcome(journal: JournalWriter, action: ActionRequest, data: Record<string, unknown>): Promise<void> {
  await journal.append({
    ts: nowIso(),
    kind: "outcome",
    playbookId: action.playbookId,
    signalId: action.signalId,
    data: { action, ...data },
  });
}
