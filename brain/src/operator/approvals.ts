import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

const ApprovalStatusSchema = z.enum(["pending", "approved", "denied", "expired"]);

export const ApprovalRecordSchema = z.object({
  id: z.string().min(1),
  actionId: z.string().min(1),
  playbookId: z.string().min(1),
  capability: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  signalId: z.string().min(1).optional(),
  status: ApprovalStatusSchema,
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1).optional(),
  resolvedAt: z.string().min(1).optional(),
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
};

export interface ApprovalsStore {
  create(input: CreateApprovalInput): Promise<ApprovalRecord>;
  get(id: string): Promise<ApprovalRecord | undefined>;
  listPending(): Promise<ApprovalRecord[]>;
  resolve(id: string, resolution: ApprovalResolution): Promise<ApprovalRecord | undefined>;
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
    const record = ApprovalRecordSchema.parse({
      ...input,
      id: this.createId(),
      status: "pending",
      createdAt: this.now(),
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
    const record = await this.get(id);
    if (!record || record.status !== "pending") {
      return record;
    }

    const resolved = ApprovalRecordSchema.parse({
      ...record,
      status: resolution === "approve" ? "approved" : "denied",
      resolvedAt: this.now(),
    });
    this.records.set(id, resolved);
    return resolved;
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
    const record = ApprovalRecordSchema.parse({
      ...input,
      id: this.createId(),
      status: "pending",
      createdAt: this.now(),
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
    const records = this.readRecords().map((record) => this.withExpiry(record));
    const index = records.findIndex((record) => record.id === id);
    if (index === -1) {
      this.writeRecords(records);
      return undefined;
    }

    const record = records[index];
    if (record.status !== "pending") {
      this.writeRecords(records);
      return record;
    }

    const resolved = ApprovalRecordSchema.parse({
      ...record,
      status: resolution === "approve" ? "approved" : "denied",
      resolvedAt: this.now(),
    });
    records[index] = resolved;
    this.writeRecords(records);
    return resolved;
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
