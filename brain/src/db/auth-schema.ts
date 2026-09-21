import { index, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { users } from "./schema.js";

function timestamptz(name: string) {
    return timestamp(name, { withTimezone: true });
}

export const authSessions = pgTable(
    "auth_sessions",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        tokenHash: text("token_hash").notNull(),
        createdAt: timestamptz("created_at").notNull().defaultNow(),
        expiresAt: timestamptz("expires_at").notNull(),
        lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
        userAgent: text("user_agent"),
    },
    (table) => [
        unique("auth_sessions_token_hash_uidx").on(table.tokenHash),
        index("auth_sessions_user_id_idx").on(table.userId),
        index("auth_sessions_expires_at_idx").on(table.expiresAt),
    ],
);

export const loginTokens = pgTable(
    "login_tokens",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id")
            .notNull()
            .references(() => users.id, { onDelete: "cascade" }),
        email: text("email").notNull(),
        tokenHash: text("token_hash").notNull(),
        createdAt: timestamptz("created_at").notNull().defaultNow(),
        expiresAt: timestamptz("expires_at").notNull(),
        consumedAt: timestamptz("consumed_at"),
    },
    (table) => [
        unique("login_tokens_token_hash_uidx").on(table.tokenHash),
        index("login_tokens_email_idx").on(table.email),
        index("login_tokens_user_id_idx").on(table.userId),
    ],
);

export type AuthSessionRow = typeof authSessions.$inferSelect;
export type NewAuthSessionRow = typeof authSessions.$inferInsert;
export type LoginTokenRow = typeof loginTokens.$inferSelect;
export type NewLoginTokenRow = typeof loginTokens.$inferInsert;
