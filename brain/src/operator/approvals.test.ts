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

    await store.create(approvalInput);
    const reloaded = new FileApprovalsStore(filePath);

    await expect(reloaded.get("approval-1")).resolves.toMatchObject({
      id: "approval-1",
      status: "pending",
      actionId: "act-1",
    });
  });
});
