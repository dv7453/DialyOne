import { randomUUID } from "node:crypto";

import type { ApprovalRecord, ApprovalResolution } from "./approvals.js";
import type { JournalWriter } from "./journal.js";
import {
  canEverPromote,
  classifySeverity,
  promotionThreshold,
  type Severity,
} from "./severity.js";

const EXPLICIT_USER_CONSENT: unique symbol = Symbol("explicitUserConsent");

export type ExplicitUserConsent = {
  readonly [EXPLICIT_USER_CONSENT]: true;
};

export function consentToGrantAutonomy(): ExplicitUserConsent {
  return { [EXPLICIT_USER_CONSENT]: true };
}

export type TrustKey = {
  userId: string;
  playbookId: string;
  capability: string;
};

export type TrustRecord = {
  id: string;
  userId: string;
  playbookId: string;
  capability: string;
  severity: Severity;
  streak: number;
  autonomyGranted: boolean;
  updatedAt: string;
};

export interface TrustLedger {
  get(key: TrustKey): Promise<TrustRecord | undefined>;
  list(): Promise<TrustRecord[]>;
  recordApproval(key: TrustKey): Promise<TrustRecord>;
  recordDenial(key: TrustKey): Promise<TrustRecord>;
  recordFailure(key: TrustKey): Promise<TrustRecord>;
  grantAutonomy(key: TrustKey, consent: ExplicitUserConsent): Promise<TrustRecord>;
  revokeAutonomy(key: TrustKey): Promise<TrustRecord>;
}

export type InMemoryTrustLedgerOptions = {
  now?: () => Date;
  createId?: () => string;
  seed?: TrustRecord[];
};

export class AutonomyGrantError extends Error {
  readonly capability: string;

  constructor(capability: string) {
    super(`Autonomy cannot be granted for ${capability}; that kind of action cannot be undone.`);
    this.name = "AutonomyGrantError";
    this.capability = capability;
  }
}

export function shouldOfferPromotion(record: TrustRecord): boolean {
  const severity = classifySeverity(record.capability);
  if (!canEverPromote(severity) || record.autonomyGranted) {
    return false;
  }
  const threshold = promotionThreshold(severity);
  return threshold !== undefined && record.streak >= threshold;
}

export class InMemoryTrustLedger implements TrustLedger {
  private readonly records = new Map<string, TrustRecord>();
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: InMemoryTrustLedgerOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? (() => randomUUID());
    for (const record of options.seed ?? []) {
      this.records.set(rowKey(record), cloneRecord(record));
    }
  }

  async get(key: TrustKey): Promise<TrustRecord | undefined> {
    const record = this.records.get(rowKey(key));
    return record ? cloneRecord(record) : undefined;
  }

  async list(): Promise<TrustRecord[]> {
    return [...this.records.values()].map(cloneRecord);
  }

  async recordApproval(key: TrustKey): Promise<TrustRecord> {
    return this.upsert(key, (current) => ({
      ...current,
      streak: current.streak + 1,
    }));
  }

  async recordDenial(key: TrustKey): Promise<TrustRecord> {
    return this.resetStreak(key);
  }

  async recordFailure(key: TrustKey): Promise<TrustRecord> {
    return this.resetStreak(key);
  }

  async grantAutonomy(key: TrustKey, _consent: ExplicitUserConsent): Promise<TrustRecord> {
    const severity = classifySeverity(key.capability);
    if (!canEverPromote(severity)) {
      throw new AutonomyGrantError(key.capability);
    }

    return this.upsert(key, (current) => ({
      ...current,
      autonomyGranted: true,
    }));
  }

  async revokeAutonomy(key: TrustKey): Promise<TrustRecord> {
    return this.upsert(key, (current) => ({
      ...current,
      streak: 0,
      autonomyGranted: false,
    }));
  }

  private async resetStreak(key: TrustKey): Promise<TrustRecord> {
    return this.upsert(key, (current) => ({
      ...current,
      streak: 0,
    }));
  }

  private async upsert(key: TrustKey, mutate: (current: TrustRecord) => TrustRecord): Promise<TrustRecord> {
    const existing = this.records.get(rowKey(key));
    const next = mutate(existing ? { ...existing } : this.blank(key));
    next.severity = classifySeverity(key.capability);
    next.updatedAt = this.now().toISOString();
    this.records.set(rowKey(key), next);
    return cloneRecord(next);
  }

  private blank(key: TrustKey): TrustRecord {
    return {
      id: this.createId(),
      userId: key.userId,
      playbookId: key.playbookId,
      capability: key.capability,
      severity: classifySeverity(key.capability),
      streak: 0,
      autonomyGranted: false,
      updatedAt: this.now().toISOString(),
    };
  }
}

export type TrustJournalCause = "denied" | "failed" | "expired";

export function trustJournalSummary(
  kind: "autonomy_used" | "promotion_available" | "autonomy_granted" | "autonomy_revoked" | "streak_reset",
  input: { capability: string; streak: number; cause?: TrustJournalCause },
): string {
  const done = capabilityDone(input.capability);
  const noun = capabilityNoun(input.capability);
  const times = formatTimes(input.streak);

  switch (kind) {
    case "autonomy_used":
      return `${done} on its own — you'd approved this ${times}.`;
    case "promotion_available":
      return `You've approved ${noun} ${times}. Dialy can start doing this without asking, if you agree. You can take this back later.`;
    case "autonomy_granted":
      return `You let Dialy run ${noun} without asking each time.`;
    case "autonomy_revoked":
      return `You took back unsupervised ${noun}. Dialy will ask again, starting from scratch.`;
    case "streak_reset":
      if (input.cause === "denied") {
        return `You said no to ${noun}, so Dialy stopped counting this toward unsupervised use.`;
      }
      if (input.cause === "expired") {
        return `Nobody answered the request to ${noun} in time, so Dialy dropped it and stopped counting this toward unsupervised use.`;
      }
      return `${done} failed, so Dialy stopped counting this toward unsupervised use.`;
  }
}

export async function applyResolvedApprovalToTrust(
  ledger: TrustLedger,
  input: ApplyResolvedApprovalToTrustInput,
): Promise<TrustRecord> {
  const key: TrustKey = {
    userId: input.userId,
    playbookId: input.approval.playbookId,
    capability: input.approval.capability,
  };

  if (input.decision === "deny") {
    const record = await ledger.recordDenial(key);
    await maybeJournal(input, "streak_reset", record, {
      cause: input.denialCause ?? "denied",
    });
    return record;
  }

  if (!input.execution.ok) {
    const record = await ledger.recordFailure(key);
    await maybeJournal(input, "streak_reset", record, { cause: "failed" });
    return record;
  }

  const record = await ledger.recordApproval(key);
  const threshold = promotionThreshold(classifySeverity(record.capability));
  if (shouldOfferPromotion(record) && threshold !== undefined && record.streak === threshold) {
    await maybeJournal(input, "promotion_available", record);
  }
  return record;
}

export async function grantEarnedAutonomy(
  ledger: TrustLedger,
  key: TrustKey,
  consent: ExplicitUserConsent,
  opts?: TrustJournalOpts,
): Promise<TrustRecord> {
  const record = await ledger.grantAutonomy(key, consent);
  await maybeJournal(
    { ...opts, userId: key.userId, approval: { playbookId: key.playbookId, capability: key.capability } },
    "autonomy_granted",
    record,
  );
  return record;
}

export async function revokeEarnedAutonomy(
  ledger: TrustLedger,
  key: TrustKey,
  opts?: TrustJournalOpts,
): Promise<TrustRecord> {
  const record = await ledger.revokeAutonomy(key);
  await maybeJournal(
    { ...opts, userId: key.userId, approval: { playbookId: key.playbookId, capability: key.capability } },
    "autonomy_revoked",
    record,
  );
  return record;
}

export type ApplyResolvedApprovalToTrustInput = {
  userId: string;
  approval: Pick<ApprovalRecord, "playbookId" | "capability"> &
    Partial<Pick<ApprovalRecord, "id" | "signalId">>;
  journal?: JournalWriter;
  now?: () => Date;
} & (
  | {
      decision: Extract<ApprovalResolution, "deny">;
      /**
       * A timeout resets the streak like a denial, but the journal must not tell
       * the user they said no when they simply never answered.
       */
      denialCause?: Extract<TrustJournalCause, "denied" | "expired">;
    }
  | { decision: Extract<ApprovalResolution, "approve">; execution: { ok: boolean } }
);

type TrustJournalOpts = {
  journal?: JournalWriter;
  now?: () => Date;
};

async function maybeJournal(
  input: {
    userId: string;
    approval: Pick<ApprovalRecord, "playbookId" | "capability"> & Partial<Pick<ApprovalRecord, "id" | "signalId">>;
    journal?: JournalWriter;
    now?: () => Date;
  },
  kind: "promotion_available" | "autonomy_granted" | "autonomy_revoked" | "streak_reset",
  record: TrustRecord,
  extra: { cause?: TrustJournalCause } = {},
): Promise<void> {
  if (!input.journal) {
    return;
  }

  await input.journal.append({
    ts: (input.now ?? (() => new Date()))().toISOString(),
    kind,
    playbookId: record.playbookId,
    ...(input.approval.signalId ? { signalId: input.approval.signalId } : {}),
    data: {
      userId: input.userId,
      capability: record.capability,
      streak: record.streak,
      severity: record.severity,
      autonomyGranted: record.autonomyGranted,
      summary: trustJournalSummary(kind, { capability: record.capability, streak: record.streak, cause: extra.cause }),
      ...(input.approval.id ? { approvalId: input.approval.id } : {}),
      ...(extra.cause ? { cause: extra.cause } : {}),
      ...(kind === "promotion_available" ? { threshold: promotionThreshold(record.severity) } : {}),
    },
  });
}

function rowKey(key: TrustKey): string {
  return `${key.userId}\0${key.playbookId}\0${key.capability}`;
}

function cloneRecord(record: TrustRecord): TrustRecord {
  return { ...record };
}

function formatTimes(count: number): string {
  return count === 1 ? "1 time" : `${count} times`;
}

const CAPABILITY_COPY: Record<string, { done: string; noun: string }> = {
  "journal.log": { done: "Logged the note", noun: "logging notes" },
  "mail.draft": { done: "Drafted the email", noun: "drafting email" },
  "mail.send": { done: "Sent the email", noun: "sending email" },
  "calendar.create": { done: "Created the calendar hold", noun: "calendar holds" },
  "notify.escalate": { done: "Sent the notification", noun: "notifications" },
  "code.draft_pr": { done: "Opened the pull request", noun: "opening pull requests" },
  "deploy.restart": { done: "Restarted the service", noun: "restarting the service" },
  "deploy.logs": { done: "Fetched the deploy logs", noun: "reading deploy logs" },
  "deploy.health": { done: "Checked deploy health", noun: "deploy health checks" },
};

function capabilityDone(capability: string): string {
  return CAPABILITY_COPY[capability]?.done ?? `Ran ${capability}`;
}

function capabilityNoun(capability: string): string {
  return CAPABILITY_COPY[capability]?.noun ?? capability;
}
