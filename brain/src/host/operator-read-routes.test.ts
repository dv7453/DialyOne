import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHostHttpServer } from "./http.js";

const ENV_KEYS = [
  "DATABASE_URL",
  "BRAIN_TOKEN",
  "DIALY_DEFAULT_USER_ID",
  "BRAIN_ALLOW_ANONYMOUS",
  "NODE_ENV",
  "OPERATOR_SCHEDULER",
  "OPERATOR_DRAIN",
] as const;

function snapshotEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
  const out = {} as Record<(typeof ENV_KEYS)[number], string | undefined>;
  for (const key of ENV_KEYS) {
    out[key] = process.env[key];
  }
  return out;
}

function restoreEnv(snapshot: Record<(typeof ENV_KEYS)[number], string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function listen(server: http.Server): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("expected tcp address");
  }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("operator journal and trust routes", () => {
  let env: ReturnType<typeof snapshotEnv>;

  beforeEach(() => {
    env = snapshotEnv();
    delete process.env.DATABASE_URL;
    delete process.env.NODE_ENV;
    process.env.BRAIN_TOKEN = "lab-secret";
    process.env.OPERATOR_SCHEDULER = "off";
    process.env.OPERATOR_DRAIN = "off";
  });

  afterEach(() => {
    restoreEnv(env);
  });

  it("advertises both read routes", async () => {
    const server = createHostHttpServer({ auth: null });
    const { baseUrl, close } = await listen(server);
    try {
      const res = await fetch(`${baseUrl}/health`, {
        headers: { authorization: "Bearer lab-secret" },
      });
      const body = (await res.json()) as { routes?: Record<string, string> };
      expect(body.routes?.["GET /v1/operator/journal"]).toBeTruthy();
      expect(body.routes?.["GET /v1/operator/trust"]).toBeTruthy();
    } finally {
      await close();
    }
  });

  it("refuses journal and trust without credentials", async () => {
    const server = createHostHttpServer({ auth: null });
    const { baseUrl, close } = await listen(server);
    try {
      const journal = await fetch(`${baseUrl}/v1/operator/journal?limit=40`);
      expect(journal.status).toBe(401);
      expect(await journal.json()).toMatchObject({ error: "unauthorized" });

      const trust = await fetch(`${baseUrl}/v1/operator/trust`);
      expect(trust.status).toBe(401);
      expect(await trust.json()).toMatchObject({ error: "unauthorized" });
    } finally {
      await close();
    }
  });
});
