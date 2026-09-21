import { safeObserve } from "../observability/index.js";
import type { ApprovalExpiryStore, ApprovalRecord } from "./approvals.js";
import type { JournalWriter } from "./journal.js";
import {
  applyResolvedApprovalToTrust,
  type TrustLedger,
} from "./trust.js";
import { isTurnPermissionApproval } from "./turn-approvals.js";

export const DEFAULT_REAPER_INTERVAL_MS = 30_000;

export type ApprovalReaperDeps = {
  approvals: ApprovalExpiryStore;
  journal: JournalWriter;
  resumeTurn?: (
    turnId: string,
    toolCallId: string,
    decision: "allow" | "deny",
  ) => Promise<void>;
  trust?: TrustLedger;
  userId?: string;
  now?: () => Date;
};

export type ReapSummary = {
  expired: number;
  turnsDenied: number;
  resumeFailed: number;
};

export async function reapExpiredApprovals(deps: ApprovalReaperDeps): Promise<ReapSummary> {
  const now = deps.now ?? (() => new Date());
  const due = await deps.approvals.expireDue();
  const summary: ReapSummary = { expired: 0, turnsDenied: 0, resumeFailed: 0 };

  for (const approval of due) {
    summary.expired += 1;
    await safeObserve(
      {
        name: "dialy.approval.expire",
        sessionId: approval.sessionId,
        turnId: approval.turnId,
        userId: deps.userId,
        input: {
          approvalId: approval.id,
          capability: approval.capability,
          playbookId: approval.playbookId,
          origin: isTurnPermissionApproval(approval) ? "turn" : "playbook",
        },
      },
      async (obs) => {
        await journalExpired(deps.journal, approval, now);
        await applyExpiryTrust(deps, approval, now);
        if (!isTurnPermissionApproval(approval)) {
          obs.update({ output: { status: "expired", origin: "playbook" } });
          return;
        }
        const resumed = await denyExpiredTurn(deps, approval, now);
        if (resumed === "denied") {
          summary.turnsDenied += 1;
        } else if (resumed === "failed") {
          summary.resumeFailed += 1;
        }
        obs.update({ output: { status: "expired", origin: "turn", resume: resumed } });
      },
    );
  }

  return summary;
}

export function startApprovalReaper(
  deps: ApprovalReaperDeps,
  intervalMs: number = readIntervalMs(),
): () => void {
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) {
      return;
    }
    ticking = true;
    void reapExpiredApprovals(deps)
      .catch(() => undefined)
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
  };
}

function readIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DIALY_APPROVAL_REAPER_MS;
  if (!raw || raw.trim() === "") {
    return DEFAULT_REAPER_INTERVAL_MS;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1_000) {
    return DEFAULT_REAPER_INTERVAL_MS;
  }
  return n;
}

async function journalExpired(
  journal: JournalWriter,
  approval: ApprovalRecord,
  now: () => Date,
): Promise<void> {
  await journal.append({
    ts: now().toISOString(),
    kind: "expired",
    playbookId: approval.playbookId,
    ...(approval.signalId ? { signalId: approval.signalId } : {}),
    data: {
      approval,
      status: "expired",
      reason: "ttl_elapsed",
      origin: isTurnPermissionApproval(approval) ? "turn" : "playbook",
    },
  });
}

async function applyExpiryTrust(
  deps: ApprovalReaperDeps,
  approval: ApprovalRecord,
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
    decision: "deny",
    denialCause: "expired",
  });
}

async function denyExpiredTurn(
  deps: ApprovalReaperDeps,
  approval: ApprovalRecord,
  now: () => Date,
): Promise<"denied" | "failed" | "skipped"> {
  const turnId = approval.turnId;
  const toolCallId = approval.toolCallId;
  if (!turnId || !toolCallId) {
    return "skipped";
  }
  if (!deps.resumeTurn) {
    await deps.journal.append({
      ts: now().toISOString(),
      kind: "outcome",
      playbookId: approval.playbookId,
      data: {
        approval,
        origin: "turn",
        status: "resume_failed",
        error: "turn runtime is not available to resume this expired approval",
      },
    });
    return "failed";
  }

  try {
    await deps.resumeTurn(turnId, toolCallId, "deny");
    return "denied";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await deps.journal.append({
      ts: now().toISOString(),
      kind: "outcome",
      playbookId: approval.playbookId,
      data: { approval, origin: "turn", status: "resume_failed", error: message },
    });
    return "failed";
  }
}
