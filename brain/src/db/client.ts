import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.js";

const DEFAULT_POOL_MAX = 10;

export type Database = PostgresJsDatabase<typeof schema>;

let client: ReturnType<typeof postgres> | undefined;
let db: Database | undefined;

function readPoolMax(): number {
    const raw = process.env.DATABASE_POOL_MAX;
    if (raw === undefined || raw === "") {
        return DEFAULT_POOL_MAX;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        return DEFAULT_POOL_MAX;
    }
    return parsed;
}

/**
 * The raw postgres.js client. Needed by anything that must pin work to a single
 * backend rather than borrowing an arbitrary pooled connection — session-level
 * advisory locks in particular, where acquiring on one connection and releasing
 * on another leaks the lock until that backend recycles.
 */
export function getSql(): ReturnType<typeof postgres> {
    if (!client) {
        getDb();
    }
    return client!;
}

export function getDb(): Database {
    if (db) {
        return db;
    }

    const url = process.env.DATABASE_URL;
    if (!url) {
        throw new Error(
            "DATABASE_URL is not set. Set it to a Postgres connection string before calling getDb().",
        );
    }

    client = postgres(url, { max: readPoolMax() });
    db = drizzle(client, { schema });
    return db;
}
