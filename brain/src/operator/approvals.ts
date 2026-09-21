import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { withDefaultExpiry } from "./expiry.js";

const ApprovalStatusSchema = z.enum(["pending", "approved", "denied", "expired"]);

export const ApprovalRecordSchema = z.object({
  id: z.string().min(1),
  actionId: z.string().min(1),
  playbookId: z.string().min(1),
  capability: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  signalId: z.string().min(1).optional(),
  status: ApprovalStatusSchema,
  // Carried on the record so a client never re-derives it: a UI with a stale copy
  // of the severity table would render an irreversible filing as routine.
  severity: z.enum(["reversible", "consequential", "irreversible"]).optional(),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1).optional(),
  resolvedAt: z.string().min(1).optional(),
  // Routing keys for a suspended turn. These are not capability arguments —
  // `args` stays the tool input the human is asked to preview.
  sessionId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  toolCallId: z.string().min(1).optional(),
});

export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
export type ApprovalResolution = "approve" | "deny";

export type CreateApprovalInput = {
  actionId: string;
  playbookId: string;
  capability: string;
  args?: Record<string, unknown>;
  signalId?: string;
  expiresAt?: string;
  severity?: ApprovalRecord["severity"];
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
};

export const TURN_ROUTE_ARG = "__dialyTurnRoute";

export type TurnPermissionRoute = {
  sessionId?: string;
  turnId: string;
  toolCallId: string;
};

export function turnRouteOf(
  record: Pick<ApprovalRecord, "sessionId" | "turnId" | "toolCallId">,
): TurnPermissionRoute | undefined {
  if (!record.turnId || !record.toolCallId) {
    return undefined;
  }
  return {
    turnId: record.turnId,
    toolCallId: record.toolCallId,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
  };
}

export function encodeTurnRouteArgs(
  args: Record<string, unknown> | undefined,
  route: TurnPermissionRoute | undefined,
): Record<string, unknown> {
  const base = args ?? {};
  if (!route) {
    return base;
  }
  return { ...base, [TURN_ROUTE_ARG]: route };
}

export function decodeTurnRouteArgs(payload: Record<string, unknown> | undefined): {
  args?: Record<string, unknown>;
  route?: TurnPermissionRoute;
} {
  if (!payload) {
    return {};
  }
  if (!(TURN_ROUTE_ARG in payload)) {
    return { args: payload };
  }
  const rest = { ...payload };
  delete rest[TURN_ROUTE_ARG];
  const route = parseTurnRoute(payload[TURN_ROUTE_ARG]);
  return {
    ...(Object.keys(rest).length > 0 ? { args: rest } : {}),
    ...(route ? { route } : {}),
  };
}

function parseTurnRoute(raw: unknown): TurnPermissionRoute | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.turnId !== "string" || rec.turnId === "" || typeof rec.toolCallId !== "string" || rec.toolCallId === "") {
    return undefined;
  }
  return {
    turnId: rec.turnId,
    toolCallId: rec.toolCallId,
    ...(typeof rec.sessionId === "string" && rec.sessionId ? { sessionId: rec.sessionId } : {}),
  };
}

/**
 * `transitioned` is false when the approval was already decided, so a replayed
 * click returns the same record as the original. Only a true transition is a
 * mandate to execute; acting on a replay sends the mail or files the return twice.
 */
export type ApprovalTransition = {
  record: ApprovalRecord;
  transitioned: boolean;
};

export interface ApprovalsStore {
  create(input: CreateApprovalInput): Promise<ApprovalRecord>;
  get(id: string): Promise<ApprovalRecord | undefined>;
  listPending(): Promise<ApprovalRecord[]>;
  resolve(id: string, resolution: ApprovalResolution): Promise<ApprovalRecord | undefined>;
  resolveTransition(id: string, resolution: ApprovalResolution): Promise<ApprovalTransition | undefined>;
}

export type ApprovalExpiryStore = ApprovalsStore & {
  expireDue(): Promise<ApprovalRecord[]>;
};

export function isApprovalOverdue(record: ApprovalRecord, nowIso: string): boolean {
  if (record.status !== "pending" || !record.expiresAt) {
    return false;
  }
  return !(Date.parse(record.expiresAt) > Date.parse(nowIso));
}

export function expireIfDue(record: ApprovalRecord, nowIso: string): ApprovalRecord {
  if (record.status === "expired" && !record.resolvedAt) {
    return ApprovalRecordSchema.parse({ ...record, resolvedAt: nowIso });
  }
  if (!isApprovalOverdue(record, nowIso)) {
    return record;
  }
  return ApprovalRecordSchema.parse({ ...record, status: "expired", resolvedAt: nowIso });
}

export type ApprovalsStoreOptions = {
  createId?: () => string;
  now?: () => string;
};

export class InMemoryApprovalsStore implements ApprovalsStore {
  private readonly records = new Map<string, ApprovalRecord>();
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(options: ApprovalsStoreOptions = {}) {
    this.createId = options.createId ?? (() => `approval-${randomUUID()}`);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateApprovalInput): Promise<ApprovalRecord> {
    const createdAt = this.now();
    const record = ApprovalRecordSchema.parse({
      ...withDefaultExpiry(input, createdAt),
      id: this.createId(),
      status: "pending",
      createdAt,
    });
    this.records.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    const record = this.records.get(id);
    if (!record) {
      return undefined;
    }

    return this.withExpiry(record);
  }

  async listPending(): Promise<ApprovalRecord[]> {
    return [...this.records.values()].map((record) => this.withExpiry(record)).filter((record) => record.status === "pending");
  }

  async resolve(id: string, resolution: ApprovalResolution): Promise<ApprovalRecord | undefined> {
    return (await this.resolveTransition(id, resolution))?.record;
  }

  async resolveTransition(
    id: string,
    resolution: ApprovalResolution,
  ): Promise<ApprovalTransition | undefined> {
    const record = await this.get(id);
    if (!record) {
      return undefined;
    }
    if (record.status !== "pending") {
      return { record, transitioned: false };
    }

    const resolved = ApprovalRecordSchema.parse({
      ...record,
      status: resolution === "approve" ? "approved" : "denied",
      resolvedAt: this.now(),
    });
    this.records.set(id, resolved);
    return { record: resolved, transitioned: true };
  }

  async expireDue(): Promise<ApprovalRecord[]> {
    const now = this.now();
    const newly: ApprovalRecord[] = [];
    for (const record of this.records.values()) {
      const expired = expireIfDue(record, now);
      if (expired !== record) {
        this.records.set(record.id, expired);
        newly.push(expired);
      }
    }
    return newly;
  }

  private withExpiry(record: ApprovalRecord): ApprovalRecord {
    if (record.status !== "pending" || !record.expiresAt || Date.parse(record.expiresAt) > Date.parse(this.now())) {
      return record;
    }

    const expired = ApprovalRecordSchema.parse({ ...record, status: "expired" });
    this.records.set(record.id, expired);
    return expired;
  }
}

export class FileApprovalsStore implements ApprovalsStore {
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(
    private readonly filePath: string,
    options: ApprovalsStoreOptions = {},
  ) {
    let next = 1;
    this.createId = options.createId ?? (() => `approval-${randomUUID()}-${next++}`);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async create(input: CreateApprovalInput): Promise<ApprovalRecord> {
    const records = this.readRecords().map((record) => this.withExpiry(record));
    const createdAt = this.now();
    const record = ApprovalRecordSchema.parse({
      ...withDefaultExpiry(input, createdAt),
      id: this.createId(),
      status: "pending",
      createdAt,
    });
    records.push(record);
    this.writeRecords(records);
    return record;
  }

  async get(id: string): Promise<ApprovalRecord | undefined> {
    const records = this.readRecords().map((stored) => this.withExpiry(stored));
    this.writeRecords(records);
    return records.find((record) => record.id === id);
  }

  async listPending(): Promise<ApprovalRecord[]> {
    const records = this.readRecords().map((record) => this.withExpiry(record));
    this.writeRecords(records);
    return records.filter((record) => record.status === "pending");
  }

  async resolve(id: string, resolution: ApprovalResolution): Promise<ApprovalRecord | undefined> {
    return (await this.resolveTransition(id, resolution))?.record;
  }

  async resolveTransition(
    id: string,
    resolution: ApprovalResolution,
  ): Promise<ApprovalTransition | undefined> {
    const records = this.readRecords().map((record) => this.withExpiry(record));
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) {
      this.writeRecords(records);
      return undefined;
    }

    const record = records[index];
    if (record.status !== "pending") {
      this.writeRecords(records);
      return { record, transitioned: false };
    }

    const resolved = ApprovalRecordSchema.parse({
      ...record,
      status: resolution === "approve" ? "approved" : "denied",
      resolvedAt: this.now(),
    });
    records[index] = resolved;
    this.writeRecords(records);
    return { record: resolved, transitioned: true };
  }

  async expireDue(): Promise<ApprovalRecord[]> {
    const now = this.now();
    const records = this.readRecords();
    const newly: ApprovalRecord[] = [];
    const next = records.map((record) => {
      const expired = expireIfDue(record, now);
      if (expired !== record) {
        newly.push(expired);
        return expired;
      }
      return record;
    });
    if (newly.length > 0) {
      this.writeRecords(next);
    }
    return newly;
  }

  private readRecords(): ApprovalRecord[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const raw = fs.readFileSync(this.filePath, "utf8").trim();
    if (!raw) {
      return [];
    }

    if (raw.startsWith("[")) {
      return z.array(ApprovalRecordSchema).parse(JSON.parse(raw));
    }

    return raw.split("\n").map((line) => ApprovalRecordSchema.parse(JSON.parse(line)));
  }

  private writeRecords(records: ApprovalRecord[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  }

  private withExpiry(record: ApprovalRecord): ApprovalRecord {
    if (record.status !== "pending" || !record.expiresAt || Date.parse(record.expiresAt) > Date.parse(this.now())) {
      return record;
    }

    return ApprovalRecordSchema.parse({ ...record, status: "expired" });
  }
}
