import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FileApprovalsStore, InMemoryApprovalsStore } from "./approvals.js";

const approvalInput = {
  actionId: "act-1",
  playbookId: "deploy-sentinel",
  capability: "deploy.restart",
  args: { service: "web" },
  signalId: "sig-1",
};

describe("InMemoryApprovalsStore", () => {
  it("creates, lists, and resolves approvals", async () => {
    const store = new InMemoryApprovalsStore({
      createId: () => "approval-1",
      now: () => "2026-08-30T10:00:00.000Z",
    });

    const approval = await store.create(approvalInput);

    expect(approval).toMatchObject({ id: "approval-1", status: "pending", ...approvalInput });
    await expect(store.listPending()).resolves.toEqual([approval]);
    await expect(store.resolve("approval-1", "approve")).resolves.toMatchObject({
      id: "approval-1",
      status: "approved",
      resolvedAt: "2026-08-30T10:00:00.000Z",
    });
    await expect(store.listPending()).resolves.toEqual([]);
  });

  it("stamps a default expiresAt so pending cards cannot linger forever", async () => {
    const store = new InMemoryApprovalsStore({
      createId: () => "approval-1",
      now: () => "2026-08-30T10:00:00.000Z",
    });

    const approval = await store.create(approvalInput);

    expect(approval.expiresAt).toBeTruthy();
    expect(Date.parse(approval.expiresAt!)).toBeGreaterThan(Date.parse(approval.createdAt));
    expect(approval.status).toBe("pending");
  });

  it("expireDue is idempotent and writes resolvedAt", async () => {
    const store = new InMemoryApprovalsStore({
      createId: () => "approval-1",
      now: () => "2026-08-30T10:00:00.000Z",
    });
    await store.create({ ...approvalInput, expiresAt: "2026-08-30T09:59:00.000Z" });

    const first = await store.expireDue();
    const second = await store.expireDue();

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ status: "expired", resolvedAt: "2026-08-30T10:00:00.000Z" });
    expect(second).toEqual([]);
  });

  it("expires pending approvals when they pass expiresAt", async () => {
    const store = new InMemoryApprovalsStore({
      createId: () => "approval-1",
      now: () => "2026-08-30T10:00:00.000Z",
    });

    await store.create({ ...approvalInput, expiresAt: "2026-08-30T09:59:00.000Z" });

    await expect(store.get("approval-1")).resolves.toMatchObject({ status: "expired" });
    await expect(store.listPending()).resolves.toEqual([]);
  });
});

describe("FileApprovalsStore", () => {
  it("persists approvals to disk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dialy-approvals-"));
    const filePath = path.join(dir, "approvals.json");
    const store = new FileApprovalsStore(filePath, {
      createId: () => "approval-1",
      now: () => "2026-08-30T10:00:00.000Z",
    });

    await store.create({
      ...approvalInput,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const reloaded = new FileApprovalsStore(filePath);

    await expect(reloaded.get("approval-1")).resolves.toMatchObject({
      id: "approval-1",
      status: "pending",
      actionId: "act-1",
    });
  });

  it("round-trips turn routing fields so a restart can still resume the turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dialy-approvals-"));
    const filePath = path.join(dir, "approvals.json");
    const store = new FileApprovalsStore(filePath, {
      createId: () => "approval-1",
      now: () => "2026-09-21T06:00:00.000Z",
    });

    await store.create({
      ...approvalInput,
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "tc-1",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    await expect(new FileApprovalsStore(filePath).get("approval-1")).resolves.toMatchObject({
      sessionId: "session-1",
      turnId: "turn-1",
      toolCallId: "tc-1",
      args: { service: "web" },
    });
  });
});

describe("resolveTransition", () => {
  it("marks only the first resolve as a mandate to execute", async () => {
    const store = new InMemoryApprovalsStore({ createId: () => "approval-1" });
    await store.create(approvalInput);

    const first = await store.resolveTransition("approval-1", "approve");
    expect(first).toMatchObject({ transitioned: true });
    expect(first?.record.status).toBe("approved");

    const replay = await store.resolveTransition("approval-1", "approve");
    expect(replay).toMatchObject({ transitioned: false });
    expect(replay?.record.status).toBe("approved");
  });

  it("does not let a later deny overturn an approval", async () => {
    const store = new InMemoryApprovalsStore({ createId: () => "approval-1" });
    await store.create(approvalInput);
    await store.resolveTransition("approval-1", "approve");

    const denied = await store.resolveTransition("approval-1", "deny");
    expect(denied).toMatchObject({ transitioned: false });
    expect(denied?.record.status).toBe("approved");
  });

  it("survives a reload on the file store", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dialy-approvals-"));
    const filePath = path.join(dir, "approvals.json");
    const store = new FileApprovalsStore(filePath, { createId: () => "approval-1" });
    await store.create(approvalInput);

    expect(await store.resolveTransition("approval-1", "approve")).toMatchObject({
      transitioned: true,
    });
    expect(
      await new FileApprovalsStore(filePath).resolveTransition("approval-1", "approve"),
    ).toMatchObject({ transitioned: false });
  });

  it("reports a missing approval rather than inventing one", async () => {
    const store = new InMemoryApprovalsStore();
    await expect(store.resolveTransition("nope", "approve")).resolves.toBeUndefined();
  });
});
