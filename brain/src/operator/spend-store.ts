export type SpendDayRecord = {
  committedNanos: bigint;
  reservedNanos: bigint;
};

export interface SpendStore {
  get(userId: string, day: string): Promise<SpendDayRecord>;
  tryReserve(userId: string, day: string, nanos: bigint, ceilingNanos: bigint): Promise<boolean>;
  settle(userId: string, day: string, reservedNanos: bigint, actualNanos: bigint): Promise<void>;
  release(userId: string, day: string, reservedNanos: bigint): Promise<void>;
}

function emptyRecord(): SpendDayRecord {
  return { committedNanos: 0n, reservedNanos: 0n };
}

function cloneRecord(record: SpendDayRecord): SpendDayRecord {
  return { committedNanos: record.committedNanos, reservedNanos: record.reservedNanos };
}

function dayKey(userId: string, day: string): string {
  return `${userId}:${day}`;
}

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(key, prev.then(() => done, () => done));
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class InMemorySpendStore implements SpendStore {
  private readonly records = new Map<string, SpendDayRecord>();
  private readonly mutex = new KeyedMutex();

  async get(userId: string, day: string): Promise<SpendDayRecord> {
    const key = dayKey(userId, day);
    return this.mutex.run(key, () => cloneRecord(this.records.get(key) ?? emptyRecord()));
  }

  async tryReserve(userId: string, day: string, nanos: bigint, ceilingNanos: bigint): Promise<boolean> {
    const key = dayKey(userId, day);
    const amount = nanos < 0n ? 0n : nanos;
    return this.mutex.run(key, () => {
      const record = this.records.get(key) ?? emptyRecord();
      const used = record.committedNanos + record.reservedNanos;
      if (used >= ceilingNanos || used + amount > ceilingNanos) {
        return false;
      }
      record.reservedNanos += amount;
      this.records.set(key, record);
      return true;
    });
  }

  async settle(userId: string, day: string, reservedNanos: bigint, actualNanos: bigint): Promise<void> {
    const key = dayKey(userId, day);
    const reserved = reservedNanos < 0n ? 0n : reservedNanos;
    const actual = actualNanos < 0n ? 0n : actualNanos;
    await this.mutex.run(key, () => {
      const record = this.records.get(key) ?? emptyRecord();
      record.reservedNanos = record.reservedNanos > reserved ? record.reservedNanos - reserved : 0n;
      record.committedNanos += actual;
      this.records.set(key, record);
    });
  }

  async release(userId: string, day: string, reservedNanos: bigint): Promise<void> {
    const key = dayKey(userId, day);
    const reserved = reservedNanos < 0n ? 0n : reservedNanos;
    await this.mutex.run(key, () => {
      const record = this.records.get(key);
      if (!record) {
        return;
      }
      record.reservedNanos = record.reservedNanos > reserved ? record.reservedNanos - reserved : 0n;
    });
  }
}
