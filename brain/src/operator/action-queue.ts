import { randomUUID } from "node:crypto";

export type QueuedActionStatus = "pending" | "succeeded" | "dead";

export type QueuedAction = {
  id: string;
  userId?: string;
  capability: string;
  args: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  status: QueuedActionStatus;
  lastError?: string;
  actionId: string;
  playbookId: string;
  signalId: string;
};

export type EnqueueActionInput = {
  id?: string;
  userId?: string;
  capability: string;
  args?: Record<string, unknown>;
  attempts?: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError?: string;
  actionId: string;
  playbookId: string;
  signalId: string;
  status?: QueuedActionStatus;
};

export type RescheduleActionInput = {
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
};

export interface ActionQueue {
  enqueue(input: EnqueueActionInput): Promise<QueuedAction>;
  listDue(now?: Date): Promise<QueuedAction[]>;
  get(id: string): Promise<QueuedAction | undefined>;
  markSucceeded(id: string): Promise<QueuedAction | undefined>;
  markDead(id: string, lastError?: string): Promise<QueuedAction | undefined>;
  reschedule(id: string, input: RescheduleActionInput): Promise<QueuedAction | undefined>;
}

export type InMemoryActionQueueOptions = {
  createId?: () => string;
  now?: () => Date;
};

export class InMemoryActionQueue implements ActionQueue {
  private readonly records = new Map<string, QueuedAction>();
  private readonly createId: () => string;
  private readonly now: () => Date;

  constructor(options: InMemoryActionQueueOptions = {}) {
    this.createId = options.createId ?? (() => `queued-action-${randomUUID()}`);
    this.now = options.now ?? (() => new Date());
  }

  async enqueue(input: EnqueueActionInput): Promise<QueuedAction> {
    const record: QueuedAction = {
      id: input.id ?? this.createId(),
      ...(input.userId ? { userId: input.userId } : {}),
      capability: input.capability,
      args: { ...(input.args ?? {}) },
      attempts: input.attempts ?? 1,
      maxAttempts: input.maxAttempts,
      nextAttemptAt: input.nextAttemptAt,
      status: input.status ?? "pending",
      ...(input.lastError ? { lastError: input.lastError } : {}),
      actionId: input.actionId,
      playbookId: input.playbookId,
      signalId: input.signalId,
    };
    this.records.set(record.id, record);
    return cloneQueuedAction(record);
  }

  async listDue(now: Date = this.now()): Promise<QueuedAction[]> {
    const nowMs = now.getTime();
    return [...this.records.values()]
      .filter((record) => record.status === "pending" && Date.parse(record.nextAttemptAt) <= nowMs)
      .sort((a, b) => Date.parse(a.nextAttemptAt) - Date.parse(b.nextAttemptAt))
      .map(cloneQueuedAction);
  }

  async get(id: string): Promise<QueuedAction | undefined> {
    const record = this.records.get(id);
    return record ? cloneQueuedAction(record) : undefined;
  }

  async markSucceeded(id: string): Promise<QueuedAction | undefined> {
    const record = this.records.get(id);
    if (!record) {
      return undefined;
    }
    record.status = "succeeded";
    return cloneQueuedAction(record);
  }

  async markDead(id: string, lastError?: string): Promise<QueuedAction | undefined> {
    const record = this.records.get(id);
    if (!record) {
      return undefined;
    }
    record.status = "dead";
    if (lastError !== undefined) {
      record.lastError = lastError;
    }
    return cloneQueuedAction(record);
  }

  async reschedule(id: string, input: RescheduleActionInput): Promise<QueuedAction | undefined> {
    const record = this.records.get(id);
    if (!record || record.status !== "pending") {
      return undefined;
    }
    record.attempts = input.attempts;
    record.nextAttemptAt = input.nextAttemptAt;
    if (input.lastError !== undefined) {
      record.lastError = input.lastError;
    }
    return cloneQueuedAction(record);
  }
}

function cloneQueuedAction(record: QueuedAction): QueuedAction {
  return {
    ...record,
    args: { ...record.args },
  };
}
