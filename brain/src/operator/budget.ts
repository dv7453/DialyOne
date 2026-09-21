import { AsyncLocalStorage } from "node:async_hooks";

import {
  computeCostNanos,
  NANOS_PER_USD,
  tokensFromUsage,
  type TokenCounts,
} from "../llm/prices.js";
import type { SpendStore } from "./spend-store.js";
import type { BudgetConfig } from "./types.js";

export type BudgetExceeded = {
  exceeded: boolean;
  action?: NonNullable<BudgetConfig["on_exceed"]>;
};

export const DEFAULT_DAILY_SPEND_CAP_USD = "5";
export const DEFAULT_BUDGET_USER_ID = "local";
export const DEFAULT_RESERVE_INPUT_TOKENS = 32_768;
export const DEFAULT_RESERVE_OUTPUT_TOKENS = 4_096;

const budgetUser = new AsyncLocalStorage<string>();

export function runWithBudgetUser<T>(userId: string, fn: () => T): T {
  return budgetUser.run(userId, fn);
}

export function currentBudgetUserId(): string {
  return budgetUser.getStore() ?? process.env.DIALY_BUDGET_USER_ID ?? DEFAULT_BUDGET_USER_ID;
}

export function usdToNanos(raw: string): bigint {
  const match = /^([0-9]+)(?:\.([0-9]{1,9}))?$/.exec(raw.trim());
  if (!match) {
    throw new Error(`Invalid USD amount: ${raw}`);
  }
  const whole = BigInt(match[1]);
  const frac = BigInt((match[2] ?? "").padEnd(9, "0").slice(0, 9));
  return whole * NANOS_PER_USD + frac;
}

export function dailySpendCeilingNanos(env: NodeJS.ProcessEnv = process.env): bigint {
  const raw = env.DIALY_DAILY_SPEND_CAP_USD;
  if (raw == null || raw.trim() === "") {
    return usdToNanos(DEFAULT_DAILY_SPEND_CAP_USD);
  }
  return usdToNanos(raw);
}

export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export type TokenEstimate = {
  inputTokens?: number;
  outputTokens?: number;
};

export type SpendReservation = {
  id: string;
  userId: string;
  day: string;
  modelId: string;
  reservedNanos: bigint;
};

export type SpendSnapshot = {
  userId: string;
  day: string;
  spentNanos: bigint;
  reservedNanos: bigint;
  ceilingNanos: bigint;
  remainingNanos: bigint;
};

export type SpendBudgetOptions = {
  store: SpendStore;
  userId?: string;
  dailyCeilingNanos?: bigint;
  now?: () => Date;
};

export function spendBudgetOptions(store: SpendStore, overrides: Omit<SpendBudgetOptions, "store"> = {}): SpendBudgetOptions {
  return {
    store,
    ...(overrides.userId ? { userId: overrides.userId } : {}),
    dailyCeilingNanos: overrides.dailyCeilingNanos ?? dailySpendCeilingNanos(),
    now: overrides.now,
  };
}

export class SpendExceededError extends Error {
  readonly name = "SpendExceededError";
  readonly userId: string;
  readonly day: string;
  readonly spentNanos: bigint;
  readonly reservedNanos: bigint;
  readonly ceilingNanos: bigint;
  readonly remainingNanos: bigint;

  constructor(snapshot: SpendSnapshot) {
    super(
      `Daily spend cap reached for ${snapshot.userId} on ${snapshot.day}: `
        + `${snapshot.spentNanos + snapshot.reservedNanos} nanos committed-or-reserved of ${snapshot.ceilingNanos} ceiling.`,
    );
    this.userId = snapshot.userId;
    this.day = snapshot.day;
    this.spentNanos = snapshot.spentNanos;
    this.reservedNanos = snapshot.reservedNanos;
    this.ceilingNanos = snapshot.ceilingNanos;
    this.remainingNanos = snapshot.remainingNanos;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isSpendExceededError(error: unknown): error is SpendExceededError {
  return error instanceof SpendExceededError || (error instanceof Error && error.name === "SpendExceededError");
}

let reservationSeq = 0;

function nextReservationId(): string {
  reservationSeq += 1;
  return `spend-res-${reservationSeq}`;
}

function clampTokens(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

export class BudgetTracker {
  private modelCalls = 0;
  private toolRounds = 0;

  constructor(
    private readonly config: BudgetConfig = {},
    private readonly spend: SpendBudgetOptions | undefined = undefined,
  ) {}

  recordModelCall(): BudgetExceeded {
    this.modelCalls += 1;
    return this.checkExceeded();
  }

  recordToolRound(): BudgetExceeded {
    this.toolRounds += 1;
    return this.checkExceeded();
  }

  checkExceeded(): BudgetExceeded {
    const modelExceeded = this.config.max_model_calls !== undefined && this.modelCalls > this.config.max_model_calls;
    const toolExceeded = this.config.max_tool_rounds !== undefined && this.toolRounds > this.config.max_tool_rounds;

    if (!modelExceeded && !toolExceeded) {
      return { exceeded: false };
    }

    return { exceeded: true, action: this.config.on_exceed ?? "escalate" };
  }

  hasSpendEnforcement(): boolean {
    return this.spend !== undefined;
  }

  async reserveCall(input: {
    modelId: string;
    userId?: string;
    estimate?: TokenEstimate;
  }): Promise<SpendReservation | undefined> {
    if (!this.spend) {
      return undefined;
    }

    const userId = input.userId ?? this.spend.userId ?? currentBudgetUserId();
    const now = (this.spend.now ?? (() => new Date()))();
    const day = utcDayKey(now);
    const ceilingNanos = this.spend.dailyCeilingNanos ?? dailySpendCeilingNanos();
    const estimate: TokenCounts = {
      inputTokens: clampTokens(input.estimate?.inputTokens, DEFAULT_RESERVE_INPUT_TOKENS),
      outputTokens: clampTokens(input.estimate?.outputTokens, DEFAULT_RESERVE_OUTPUT_TOKENS),
    };
    const reservedNanos = computeCostNanos(input.modelId, estimate);
    const ok = await this.spend.store.tryReserve(userId, day, reservedNanos, ceilingNanos);
    if (!ok) {
      throw new SpendExceededError(await this.readSnapshot(userId, day, ceilingNanos));
    }

    return {
      id: nextReservationId(),
      userId,
      day,
      modelId: input.modelId,
      reservedNanos,
    };
  }

  async settleCall(reservation: SpendReservation | undefined, usage?: unknown): Promise<void> {
    if (!this.spend || !reservation) {
      return;
    }

    const tokens = tokensFromUsage(usage);
    const actualNanos = tokens == null
      ? reservation.reservedNanos
      : computeCostNanos(reservation.modelId, tokens);
    await this.spend.store.settle(reservation.userId, reservation.day, reservation.reservedNanos, actualNanos);
  }

  async releaseCall(reservation: SpendReservation | undefined): Promise<void> {
    if (!this.spend || !reservation) {
      return;
    }
    await this.spend.store.release(reservation.userId, reservation.day, reservation.reservedNanos);
  }

  async snapshot(userId?: string): Promise<SpendSnapshot | undefined> {
    if (!this.spend) {
      return undefined;
    }
    const resolvedUser = userId ?? this.spend.userId ?? currentBudgetUserId();
    const now = (this.spend.now ?? (() => new Date()))();
    const day = utcDayKey(now);
    const ceilingNanos = this.spend.dailyCeilingNanos ?? dailySpendCeilingNanos();
    return this.readSnapshot(resolvedUser, day, ceilingNanos);
  }

  private async readSnapshot(userId: string, day: string, ceilingNanos: bigint): Promise<SpendSnapshot> {
    const record = await this.spend!.store.get(userId, day);
    const used = record.committedNanos + record.reservedNanos;
    const remainingNanos = ceilingNanos > used ? ceilingNanos - used : 0n;
    return {
      userId,
      day,
      spentNanos: record.committedNanos,
      reservedNanos: record.reservedNanos,
      ceilingNanos,
      remainingNanos,
    };
  }
}
