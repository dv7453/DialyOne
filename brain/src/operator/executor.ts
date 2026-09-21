import type { ActionQueue } from "./action-queue.js";
import type { ApprovalsStore, ApprovalRecord } from "./approvals.js";
import type { CapabilityRegistry } from "./capabilities/registry.js";
import type { CapabilityContext, CapabilityResult } from "./capabilities/types.js";
import type { EngineResult } from "./engine.js";
import { withDefaultExpiry } from "./expiry.js";
import type { JournalWriter } from "./journal.js";
import { DEFAULT_MAX_ATTEMPTS, classifyFailure, errorText, retryDelayMs } from "./retry.js";
import { canEverPromote, classifySeverity, promotionThreshold } from "./severity.js";
import {
  shouldOfferPromotion,
  trustJournalSummary,
  type TrustJournalCause,
  type TrustKey,
  type TrustLedger,
} from "./trust.js";
import type { ActionRequest, PolicyMode } from "./types.js";
import { safeObserve } from "../observability/index.js";

export type ExecutionStatus = "skipped" | "pending_approval" | "executed" | "failed" | "retry_scheduled";

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

export type ExecuteOpts = {
  queue?: ActionQueue;
  maxAttempts?: number;
  now?: () => Date;
  userId?: string;
  trust?: TrustLedger;
};

export type DrainSummary = {
  processed: number;
  succeeded: number;
  rescheduled: number;
  dead: number;
};

function resolveNow(opts?: Pick<ExecuteOpts, "now">): Date {
  return (opts?.now ?? (() => new Date()))();
}

function nowIso(opts?: Pick<ExecuteOpts, "now">): string {
  return resolveNow(opts).toISOString();
}

export async function executeEngineResult(
  result: EngineResult,
  registry: CapabilityRegistry,
  approvals: ApprovalsStore,
  journal: JournalWriter,
  opts?: ExecuteOpts,
): Promise<ExecutionSummary> {
  return safeObserve(
    {
      name: "dialy.operator.execute",
      userId: opts?.userId,
      metadata: { signalId: result.signalId },
      input: { signalId: result.signalId, actions: result.matches.flatMap((m) => m.actions).length },
    },
    async (obs) => {
      const records: ExecutionRecord[] = [];

      for (const match of result.matches) {
        for (const action of match.actions) {
          const record = await executeAction(action, registry, approvals, journal, opts);
          records.push(record);
        }
      }

      const summary = {
        signalId: result.signalId,
        actions: records,
      };
      obs.update({
        output: {
          signalId: summary.signalId,
          actions: records.map((record) => ({
            actionId: record.actionId,
            capability: record.capability,
            status: record.status,
            approvalId: record.approval?.id,
          })),
        },
      });
      return summary;
    },
  );
}

async function executeAction(
  action: ActionRequest,
  registry: CapabilityRegistry,
  approvals: ApprovalsStore,
  journal: JournalWriter,
  opts?: ExecuteOpts,
): Promise<ExecutionRecord> {
  return safeObserve(
    {
      name: "dialy.operator.action",
      userId: opts?.userId,
      input: {
        actionId: action.id,
        playbookId: action.playbookId,
        capability: action.capability,
        mode: action.mode,
        args: action.args,
        signalId: action.signalId,
      },
    },
    async (obs) => {
      const record = await runExecuteAction(action, registry, approvals, journal, opts);
      obs.update({
        output: {
          actionId: record.actionId,
          status: record.status,
          approvalId: record.approval?.id,
          ok: record.result?.ok,
        },
      });
      return record;
    },
  );
}

async function runExecuteAction(
  action: ActionRequest,
  registry: CapabilityRegistry,
  approvals: ApprovalsStore,
  journal: JournalWriter,
  opts?: ExecuteOpts,
): Promise<ExecutionRecord> {
  if (action.mode === "log") {
    const record: ExecutionRecord = baseRecord(action, "skipped");
    await appendOutcome(journal, action, { status: record.status, reason: "Log-mode action recorded without execution." }, opts);
    return record;
  }

  if (action.mode === "approve") {
    const earned = await earnedAutonomyRecord(action, opts);
    if (earned) {
      await journal.append({
        ts: nowIso(opts),
        kind: "autonomy_used",
        playbookId: action.playbookId,
        signalId: action.signalId,
        data: {
          action,
          capability: action.capability,
          streak: earned.streak,
          summary: trustJournalSummary("autonomy_used", {
            capability: action.capability,
            streak: earned.streak,
          }),
        },
      });
      const executeArgs = buildExecuteArgs(action);
      const result = await invokeRegistry(registry, action.capability, executeArgs, {
        signalId: action.signalId,
        playbookId: action.playbookId,
      });
      return settleExecution(action, action.capability, executeArgs, result, journal, opts);
    }

    const approval = await approvals.create(
      withDefaultExpiry(
        {
          actionId: action.id,
          playbookId: action.playbookId,
          capability: action.capability,
          args: action.args,
          signalId: action.signalId,
          severity: classifySeverity(action.capability),
        },
        nowIso(opts),
      ),
    );
    const record: ExecutionRecord = { ...baseRecord(action, "pending_approval"), approval };
    await appendOutcome(journal, action, { status: record.status, approval }, opts);
    return record;
  }

  if (action.mode === "escalate") {
    const executeArgs = {
      title: `Operator escalation: ${action.capability}`,
      body: JSON.stringify({ action }, null, 2),
      action,
      args: action.args ?? {},
    };
    const result = await invokeRegistry(registry, "notify.escalate", executeArgs, {
      signalId: action.signalId,
      playbookId: action.playbookId,
    });
    await journal.append({
      ts: nowIso(opts),
      kind: "escalate",
      playbookId: action.playbookId,
      signalId: action.signalId,
      data: { action, result },
    });
    return settleExecution(action, "notify.escalate", executeArgs, result, journal, opts);
  }

  const executeArgs = buildExecuteArgs(action);
  const result = await invokeRegistry(registry, action.capability, executeArgs, {
    signalId: action.signalId,
    playbookId: action.playbookId,
  });
  return settleExecution(action, action.capability, executeArgs, result, journal, opts);
}

export async function drainActionQueue(
  queue: ActionQueue,
  registry: CapabilityRegistry,
  journal: JournalWriter,
  opts?: Pick<ExecuteOpts, "now" | "trust">,
): Promise<DrainSummary> {
  const due = await queue.listDue(resolveNow(opts));
  const summary: DrainSummary = { processed: 0, succeeded: 0, rescheduled: 0, dead: 0 };

  for (const item of due) {
    summary.processed += 1;
    const result = await invokeRegistry(registry, item.capability, item.args, {
      signalId: item.signalId,
      playbookId: item.playbookId,
    });

    if (result.ok) {
      await queue.markSucceeded(item.id);
      await journal.append({
        ts: nowIso(opts),
        kind: "outcome",
        playbookId: item.playbookId,
        signalId: item.signalId,
        data: { status: "executed", queuedActionId: item.id, result, via: "retry" },
      });
      await recordTrustOutcome(
        { playbookId: item.playbookId, capability: item.capability, signalId: item.signalId },
        { ok: true },
        journal,
        { ...opts, ...(item.userId ? { userId: item.userId } : {}) },
      );
      summary.succeeded += 1;
      continue;
    }

    const attempts = item.attempts + 1;
    const lastError = result.error ?? "Capability execution failed.";
    const canRetry = classifyFailure(result) === "retryable" && attempts < item.maxAttempts;

    if (canRetry) {
      const nextAttemptAt = new Date(resolveNow(opts).getTime() + retryDelayMs(attempts)).toISOString();
      await queue.reschedule(item.id, { attempts, nextAttemptAt, lastError });
      await journal.append({
        ts: nowIso(opts),
        kind: "retry_scheduled",
        playbookId: item.playbookId,
        signalId: item.signalId,
        data: {
          queuedActionId: item.id,
          actionId: item.actionId,
          capability: item.capability,
          attempt: attempts,
          maxAttempts: item.maxAttempts,
          nextAttemptAt,
          lastError,
          result,
        },
      });
      summary.rescheduled += 1;
      continue;
    }

    await queue.markDead(item.id, lastError);
    await journal.append({
      ts: nowIso(opts),
      kind: "dead_letter",
      playbookId: item.playbookId,
      signalId: item.signalId,
      data: {
        queuedActionId: item.id,
        actionId: item.actionId,
        capability: item.capability,
        attempt: attempts,
        maxAttempts: item.maxAttempts,
        lastError,
        result,
        explanation: deadLetterExplanation({
          capability: item.capability,
          playbookId: item.playbookId,
          lastError,
          attempts,
          maxAttempts: item.maxAttempts,
          exhausted: attempts >= item.maxAttempts,
        }),
      },
    });
    await recordTrustOutcome(
      { playbookId: item.playbookId, capability: item.capability, signalId: item.signalId },
      { ok: false, cause: "failed" },
      journal,
      { ...opts, ...(item.userId ? { userId: item.userId } : {}) },
    );
    summary.dead += 1;
  }

  return summary;
}

async function settleExecution(
  action: ActionRequest,
  capability: string,
  args: Record<string, unknown>,
  result: CapabilityResult,
  journal: JournalWriter,
  opts?: ExecuteOpts,
): Promise<ExecutionRecord> {
  if (result.ok) {
    const record: ExecutionRecord = { ...baseRecord(action, "executed"), result };
    await appendOutcome(journal, action, { status: record.status, result }, opts);
    await recordTrustIfTracked(action, { ok: true }, journal, opts);
    return record;
  }

  const queue = opts?.queue;
  // Without a queue, keep one-shot semantics so existing callers still see a terminal failure.
  if (!queue) {
    const record: ExecutionRecord = { ...baseRecord(action, "failed"), result };
    await appendOutcome(journal, action, { status: record.status, result }, opts);
    await recordTrustIfTracked(action, { ok: false, cause: "failed" }, journal, opts);
    return record;
  }

  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const attempts = 1;
  const lastError = result.error ?? "Capability execution failed.";
  const canRetry = classifyFailure(result) === "retryable" && attempts < maxAttempts;

  if (canRetry) {
    const nextAttemptAt = new Date(resolveNow(opts).getTime() + retryDelayMs(attempts)).toISOString();
    const queued = await queue.enqueue({
      ...(opts?.userId ? { userId: opts.userId } : {}),
      capability,
      args,
      attempts,
      maxAttempts,
      nextAttemptAt,
      lastError,
      actionId: action.id,
      playbookId: action.playbookId,
      signalId: action.signalId,
    });
    const record: ExecutionRecord = { ...baseRecord(action, "retry_scheduled"), result };
    await journal.append({
      ts: nowIso(opts),
      kind: "retry_scheduled",
      playbookId: action.playbookId,
      signalId: action.signalId,
      data: {
        queuedActionId: queued.id,
        action,
        capability,
        attempt: attempts,
        maxAttempts,
        nextAttemptAt,
        lastError,
        result,
      },
    });
    await appendOutcome(journal, action, { status: record.status, result, queuedActionId: queued.id, nextAttemptAt }, opts);
    return record;
  }

  const queued = await queue.enqueue({
    ...(opts?.userId ? { userId: opts.userId } : {}),
    capability,
    args,
    attempts,
    maxAttempts,
    nextAttemptAt: nowIso(opts),
    lastError,
    actionId: action.id,
    playbookId: action.playbookId,
    signalId: action.signalId,
    status: "dead",
  });
  const record: ExecutionRecord = { ...baseRecord(action, "failed"), result };
  const explanation = deadLetterExplanation({
    capability,
    playbookId: action.playbookId,
    lastError,
    attempts,
    maxAttempts,
    exhausted: attempts >= maxAttempts,
  });
  await journal.append({
    ts: nowIso(opts),
    kind: "dead_letter",
    playbookId: action.playbookId,
    signalId: action.signalId,
    data: {
      queuedActionId: queued.id,
      action,
      capability,
      attempt: attempts,
      maxAttempts,
      lastError,
      result,
      explanation,
    },
  });
  await appendOutcome(journal, action, { status: record.status, result, queuedActionId: queued.id, explanation }, opts);
  await recordTrustIfTracked(action, { ok: false, cause: "failed" }, journal, opts);
  return record;
}

async function invokeRegistry(
  registry: CapabilityRegistry,
  capability: string,
  args: Record<string, unknown>,
  ctx: CapabilityContext,
): Promise<CapabilityResult> {
  try {
    return await registry.execute(capability, args, ctx);
  } catch (error) {
    return {
      ok: false,
      capability,
      error: errorText(error),
    };
  }
}

function deadLetterExplanation(input: {
  capability: string;
  playbookId: string;
  lastError: string;
  attempts: number;
  maxAttempts: number;
  exhausted: boolean;
}): string {
  if (input.exhausted) {
    return `Dialy stopped retrying ${input.capability} for playbook ${input.playbookId} after ${input.attempts} attempt(s). Last error: ${input.lastError}. This action did not run.`;
  }
  return `Dialy did not retry ${input.capability} for playbook ${input.playbookId} because the failure is not transient: ${input.lastError}. This action did not run.`;
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

async function appendOutcome(
  journal: JournalWriter,
  action: ActionRequest,
  data: Record<string, unknown>,
  opts?: Pick<ExecuteOpts, "now">,
): Promise<void> {
  await journal.append({
    ts: nowIso(opts),
    kind: "outcome",
    playbookId: action.playbookId,
    signalId: action.signalId,
    data: { action, ...data },
  });
}

function buildExecuteArgs(action: ActionRequest): Record<string, unknown> {
  if (action.capability === "notify.escalate") {
    return {
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
    };
  }
  return action.args ?? {};
}

function trustKey(action: ActionRequest, opts?: ExecuteOpts): TrustKey | undefined {
  if (!opts?.trust || !opts.userId) {
    return undefined;
  }
  return { userId: opts.userId, playbookId: action.playbookId, capability: action.capability };
}

async function earnedAutonomyRecord(action: ActionRequest, opts?: ExecuteOpts) {
  const key = trustKey(action, opts);
  const trust = opts?.trust;
  if (!key || !trust) {
    return undefined;
  }
  // Severity is the authority: a granted row must not autorun irreversible work.
  if (!canEverPromote(classifySeverity(action.capability))) {
    return undefined;
  }
  const current = await trust.get(key);
  return current?.autonomyGranted ? current : undefined;
}

async function recordTrustIfTracked(
  action: ActionRequest,
  outcome: { ok: true } | { ok: false; cause: TrustJournalCause },
  journal: JournalWriter,
  opts?: ExecuteOpts,
): Promise<void> {
  if (action.mode === "escalate") {
    return;
  }
  await recordTrustOutcome(action, outcome, journal, opts);
}

async function recordTrustOutcome(
  action: { playbookId: string; capability: string; signalId?: string },
  outcome: { ok: true } | { ok: false; cause: TrustJournalCause },
  journal: JournalWriter,
  opts?: Pick<ExecuteOpts, "now" | "trust" | "userId">,
): Promise<void> {
  const trust = opts?.trust;
  const userId = opts?.userId;
  if (!trust || !userId) {
    return;
  }

  const key: TrustKey = { userId, playbookId: action.playbookId, capability: action.capability };
  if (outcome.ok) {
    const record = await trust.recordApproval(key);
    const threshold = promotionThreshold(classifySeverity(record.capability));
    if (shouldOfferPromotion(record) && threshold !== undefined && record.streak === threshold) {
      await journal.append({
        ts: nowIso(opts),
        kind: "promotion_available",
        playbookId: action.playbookId,
        ...(action.signalId ? { signalId: action.signalId } : {}),
        data: {
          userId,
          capability: record.capability,
          streak: record.streak,
          severity: record.severity,
          threshold,
          summary: trustJournalSummary("promotion_available", {
            capability: record.capability,
            streak: record.streak,
          }),
        },
      });
    }
    return;
  }

  const record = await trust.recordFailure(key);
  await journal.append({
    ts: nowIso(opts),
    kind: "streak_reset",
    playbookId: action.playbookId,
    ...(action.signalId ? { signalId: action.signalId } : {}),
    data: {
      userId,
      capability: record.capability,
      streak: record.streak,
      cause: outcome.cause,
      summary: trustJournalSummary("streak_reset", {
        capability: record.capability,
        streak: record.streak,
        cause: outcome.cause,
      }),
    },
  });
}
