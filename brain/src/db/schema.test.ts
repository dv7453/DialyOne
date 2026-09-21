import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { authSessions, loginTokens } from "./auth-schema.js";
import {
    actionQueue,
    agentTasks,
    approvals,
    credentials,
    journal,
    openLoops,
    schedulerState,
    spendLedger,
    trustLedger,
    users,
} from "./schema.js";

function columnNames(table: Parameters<typeof getTableColumns>[0]): string[] {
    return Object.keys(getTableColumns(table));
}

describe("db schema", () => {
    it("exports the persistence tables", () => {
        expect(getTableName(users)).toBe("users");
        expect(getTableName(credentials)).toBe("credentials");
        expect(getTableName(approvals)).toBe("approvals");
        expect(getTableName(journal)).toBe("journal");
        expect(getTableName(trustLedger)).toBe("trust_ledger");
        expect(getTableName(openLoops)).toBe("open_loops");
        expect(getTableName(agentTasks)).toBe("agent_tasks");
        expect(getTableName(schedulerState)).toBe("scheduler_state");
        expect(getTableName(actionQueue)).toBe("action_queue");
        expect(getTableName(spendLedger)).toBe("spend_ledger");
        expect(getTableName(authSessions)).toBe("auth_sessions");
        expect(getTableName(loginTokens)).toBe("login_tokens");
    });

    it("scopes user data tables with userId", () => {
        const tenantTables = [
            credentials,
            approvals,
            journal,
            trustLedger,
            openLoops,
            agentTasks,
            schedulerState,
            actionQueue,
            spendLedger,
            authSessions,
            loginTokens,
        ];

        for (const table of tenantTables) {
            expect(columnNames(table)).toContain("userId");
        }
    });

    it("exposes key columns on each table", () => {
        expect(columnNames(users)).toEqual(
            expect.arrayContaining(["id", "email", "displayName", "locale", "createdAt", "deletedAt"]),
        );
        expect(columnNames(credentials)).toEqual(
            expect.arrayContaining(["id", "userId", "provider", "encryptedPayload", "createdAt", "updatedAt"]),
        );
        expect(columnNames(approvals)).toEqual(
            expect.arrayContaining([
                "id",
                "userId",
                "actionId",
                "playbookId",
                "capability",
                "args",
                "signalId",
                "status",
                "createdAt",
                "expiresAt",
                "decidedAt",
            ]),
        );
        expect(columnNames(journal)).toEqual(
            expect.arrayContaining(["id", "userId", "kind", "playbookId", "signalId", "payload", "createdAt"]),
        );
        expect(columnNames(trustLedger)).toEqual(
            expect.arrayContaining([
                "id",
                "userId",
                "playbookId",
                "capability",
                "severity",
                "streak",
                "autonomyGranted",
                "updatedAt",
            ]),
        );
        expect(columnNames(openLoops)).toEqual(
            expect.arrayContaining([
                "id",
                "userId",
                "intent",
                "capability",
                "knownArgs",
                "missingArgs",
                "dueAt",
                "sourceChannel",
                "status",
                "createdAt",
            ]),
        );
        expect(columnNames(agentTasks)).toEqual(
            expect.arrayContaining([
                "id",
                "userId",
                "provider",
                "externalId",
                "prompt",
                "status",
                "result",
                "createdAt",
                "updatedAt",
            ]),
        );
        expect(columnNames(schedulerState)).toEqual(
            expect.arrayContaining(["key", "userId", "lastRunAt", "payload"]),
        );
        expect(columnNames(actionQueue)).toEqual(
            expect.arrayContaining([
                "id",
                "userId",
                "capability",
                "actionId",
                "playbookId",
                "signalId",
                "args",
                "attempts",
                "maxAttempts",
                "nextAttemptAt",
                "status",
                "lastError",
                "createdAt",
                "updatedAt",
            ]),
        );
        expect(columnNames(spendLedger)).toEqual(
            expect.arrayContaining([
                "id",
                "userId",
                "day",
                "reservedNanos",
                "spentNanos",
                "reservedUpdatedAt",
                "createdAt",
                "updatedAt",
            ]),
        );
    });

    it("cascades every user_id foreign key so a hard DELETE of users is erasure", () => {
        const tenantTables = [
            credentials,
            approvals,
            journal,
            trustLedger,
            openLoops,
            agentTasks,
            schedulerState,
            actionQueue,
            spendLedger,
            authSessions,
            loginTokens,
        ];

        for (const table of tenantTables) {
            const fks = getTableConfig(table).foreignKeys;
            const userFks = fks.filter((fk) =>
                fk.reference().columns.some((column) => column.name === "user_id"),
            );
            expect(userFks.length, getTableName(table)).toBeGreaterThan(0);
            for (const fk of userFks) {
                expect(fk.onDelete, getTableName(table)).toBe("cascade");
            }
        }

        const userFks = getTableConfig(users).foreignKeys.filter((fk) =>
            fk.reference().columns.some((column) => column.name === "user_id"),
        );
        expect(userFks).toEqual([]);
    });
});
