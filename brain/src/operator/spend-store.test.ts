import { describe, expect, it } from "vitest";

import { InMemorySpendStore } from "./spend-store.js";

describe("InMemorySpendStore", () => {
  it("starts a user-day at zero", async () => {
    const store = new InMemorySpendStore();
    await expect(store.get("u1", "2026-09-21")).resolves.toEqual({
      committedNanos: 0n,
      reservedNanos: 0n,
    });
  });

  it("reserves until the ceiling and rejects the overflow", async () => {
    const store = new InMemorySpendStore();
    await expect(store.tryReserve("u1", "2026-09-21", 700n, 1000n)).resolves.toBe(true);
    await expect(store.tryReserve("u1", "2026-09-21", 300n, 1000n)).resolves.toBe(true);
    await expect(store.tryReserve("u1", "2026-09-21", 1n, 1000n)).resolves.toBe(false);
    await expect(store.get("u1", "2026-09-21")).resolves.toEqual({
      committedNanos: 0n,
      reservedNanos: 1000n,
    });
  });

  it("settles actual spend and releases unused reservation", async () => {
    const store = new InMemorySpendStore();
    await store.tryReserve("u1", "2026-09-21", 800n, 1000n);
    await store.settle("u1", "2026-09-21", 800n, 250n);
    await expect(store.get("u1", "2026-09-21")).resolves.toEqual({
      committedNanos: 250n,
      reservedNanos: 0n,
    });
  });

  it("isolates users and UTC days", async () => {
    const store = new InMemorySpendStore();
    await store.tryReserve("a", "2026-09-21", 100n, 1000n);
    await store.settle("a", "2026-09-21", 100n, 100n);
    await expect(store.get("b", "2026-09-21")).resolves.toEqual({
      committedNanos: 0n,
      reservedNanos: 0n,
    });
    await expect(store.get("a", "2026-09-22")).resolves.toEqual({
      committedNanos: 0n,
      reservedNanos: 0n,
    });
  });
});
