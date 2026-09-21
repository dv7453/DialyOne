import { sql } from "drizzle-orm";
import {
    bigint,
    boolean,
    index,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    unique,
    uuid,
} from "drizzle-orm/pg-core";

function timestamptz(name: string) {
    return timestamp(name, { withTimezone: true });
}

/**
 * Tenant root. Every other table cascades from here, so a DPDP erasure request
 * is a single hard DELETE. `deletedAt` is deactivation, which deliberately does
 * NOT cascade — erasure and deactivation are different promises to the user.
 */
export const users = pgTable("users", {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    displayName: text("display_name"),
    locale: text("locale").notNull().default("en"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    deletedAt: timestamptz("deleted_at"),
});

export const credentials = pgTable(
    "credentials",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        provider: text("provider").notNull(),
        encryptedPayload: text("encrypted_payload").notNull(),
        createdAt: timestamptz("created_at").notNull().defaultNow(),
        updatedAt: timestamptz("updated_at")
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        unique("credentials_user_id_provider_uidx").on(table.userId, table.provider),
        index("credentials_user_id_idx").on(table.userId),
    ],
);

export const approvals = pgTable(
    "approvals",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        actionId: text("action_id").notNull(),
        playbookId: text("playbook_id").notNull(),
        capability: text("capability").notNull(),
        args: jsonb("args").notNull(),
        signalId: text("signal_id"),
        status: text("status").$type<"pending" | "approved" | "denied" | "expired">().notNull(),
        createdAt: timestamptz("created_at").notNull().defaultNow(),
        expiresAt: timestamptz("expires_at"),
        decidedAt: timestamptz("decided_at"),
    },
    (table) => [index("approvals_user_id_idx").on(table.userId)],
);

export const journal = pgTable(
    "journal",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        kind: text("kind").notNull(),
        playbookId: text("playbook_id"),
        signalId: text("signal_id"),
        payload: jsonb("payload").notNull(),
        createdAt: timestamptz("created_at").notNull().defaultNow(),
    },
    (table) => [
        index("journal_user_id_idx").on(table.userId),
        index("journal_user_id_created_at_idx").on(table.userId, table.createdAt),
    ],
);

export const trustLedger = pgTable(
    "trust_ledger",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        playbookId: text("playbook_id").notNull(),
        capability: text("capability").notNull(),
        severity: text("severity").$type<"reversible" | "consequential" | "irreversible">().notNull(),
        streak: integer("streak").notNull().default(0),
        autonomyGranted: boolean("autonomy_granted").notNull().default(false),
        updatedAt: timestamptz("updated_at")
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        unique("trust_ledger_user_playbook_capability_uidx").on(
            table.userId,
            table.playbookId,
            table.capability,
        ),
        index("trust_ledger_user_id_idx").on(table.userId),
    ],
);

export const openLoops = pgTable(
    "open_loops",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        intent: text("intent").notNull(),
        capability: text("capability"),
        knownArgs: jsonb("known_args").notNull(),
        missingArgs: jsonb("missing_args").$type<string[]>().notNull(),
        dueAt: timestamptz("due_at"),
        sourceChannel: text("source_channel"),
        status: text("status").$type<"open" | "fulfilled" | "cancelled">().notNull(),
        createdAt: timestamptz("created_at").notNull().defaultNow(),
    },
    (table) => [index("open_loops_user_id_idx").on(table.userId)],
);

export const agentTasks = pgTable(
    "agent_tasks",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        provider: text("provider").notNull(),
        externalId: text("external_id"),
        prompt: text("prompt").notNull(),
        status: text("status").notNull(),
        result: jsonb("result"),
        createdAt: timestamptz("created_at").notNull().defaultNow(),
        updatedAt: timestamptz("updated_at")
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [index("agent_tasks_user_id_idx").on(table.userId)],
);

export const schedulerState = pgTable(
    "scheduler_state",
    {
        key: text("key").primaryKey(),
        // Nullable: some scheduler keys are process-global rather than per-user.
        userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
        lastRunAt: timestamptz("last_run_at"),
        payload: jsonb("payload"),
    },
    (table) => [index("scheduler_state_user_id_idx").on(table.userId)],
);

export const actionQueue = pgTable(
    "action_queue",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        capability: text("capability").notNull(),
        actionId: text("action_id").notNull(),
        playbookId: text("playbook_id").notNull(),
        signalId: text("signal_id").notNull(),
        args: jsonb("args").notNull(),
        attempts: integer("attempts").notNull().default(0),
        maxAttempts: integer("max_attempts").notNull().default(5),
        nextAttemptAt: timestamptz("next_attempt_at").notNull(),
        status: text("status").$type<"pending" | "succeeded" | "dead">().notNull(),
        lastError: text("last_error"),
        createdAt: timestamptz("created_at").notNull().defaultNow(),
        updatedAt: timestamptz("updated_at")
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        index("action_queue_user_id_idx").on(table.userId),
        index("action_queue_status_next_attempt_at_idx").on(table.status, table.nextAttemptAt),
    ],
);

/**
 * Daily LLM spend. Amounts are integer nano-USD (1 USD = 1e9) and routinely
 * exceed 32 bits ($5 = 5e9). PostgreSQL `bigint` (int64) cannot silently
 * round; `integer` overflows at ~$2.15 and float is forbidden. Drizzle
 * `mode: "bigint"` keeps values above 2^53 exact in JS.
 *
 * `reserved_updated_at` is the in-flight clock. A reservation whose stamp is
 * older than the store TTL is treated as released so a crash cannot pin the
 * day's ceiling until UTC midnight.
 */
export const spendLedger = pgTable(
    "spend_ledger",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        day: text("day").notNull(),
        reservedNanos: bigint("reserved_nanos", { mode: "bigint" }).notNull().default(sql`0`),
        spentNanos: bigint("spent_nanos", { mode: "bigint" }).notNull().default(sql`0`),
        reservedUpdatedAt: timestamptz("reserved_updated_at").notNull().defaultNow(),
        createdAt: timestamptz("created_at").notNull().defaultNow(),
        updatedAt: timestamptz("updated_at")
            .notNull()
            .defaultNow()
            .$onUpdate(() => new Date()),
    },
    (table) => [
        unique("spend_ledger_user_id_day_uidx").on(table.userId, table.day),
        index("spend_ledger_user_id_idx").on(table.userId),
    ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;

export type Approval = typeof approvals.$inferSelect;
export type NewApproval = typeof approvals.$inferInsert;

export type Journal = typeof journal.$inferSelect;
export type NewJournal = typeof journal.$inferInsert;

export type TrustLedger = typeof trustLedger.$inferSelect;
export type NewTrustLedger = typeof trustLedger.$inferInsert;

export type OpenLoop = typeof openLoops.$inferSelect;
export type NewOpenLoop = typeof openLoops.$inferInsert;

export type AgentTask = typeof agentTasks.$inferSelect;
export type NewAgentTask = typeof agentTasks.$inferInsert;

export type SchedulerState = typeof schedulerState.$inferSelect;
export type NewSchedulerState = typeof schedulerState.$inferInsert;

export type ActionQueue = typeof actionQueue.$inferSelect;
export type NewActionQueue = typeof actionQueue.$inferInsert;

export type SpendLedger = typeof spendLedger.$inferSelect;
export type NewSpendLedger = typeof spendLedger.$inferInsert;
