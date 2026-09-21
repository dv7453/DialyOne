import { AsyncLocalStorage } from "node:async_hooks";

export type AuthContext = {
    userId: string;
    sessionId?: string;
    via: "session" | "static_token";
};

export class MissingAuthContextError extends Error {
    constructor(message = "No authenticated user in the current async context") {
        super(message);
        this.name = "MissingAuthContextError";
    }
}

const storage = new AsyncLocalStorage<AuthContext>();

/*
 * Hazard: AsyncLocalStorage is request-scoped. It follows the async continuation
 * of the call that entered `runWithAuthContext`, but it is lost across work that
 * is scheduled onto a different lifetime — a queue drain, a setInterval tick,
 * a worker, or any callback invoked after the originating request has finished.
 *
 * Background work (the operator scheduler, the action-queue drain) must pass
 * the user id explicitly rather than calling getCurrentUserId() /
 * requireCurrentUserId(). Reading ambient context from those paths is a
 * correctness bug: it will silently see `undefined` (or, worse, a later
 * request's user if the drain is interleaved incorrectly).
 */

export function runWithAuthContext<T>(ctx: AuthContext, fn: () => T): T {
    return storage.run(ctx, fn);
}

export function getAuthContext(): AuthContext | undefined {
    return storage.getStore();
}

export function getCurrentUserId(): string | undefined {
    return storage.getStore()?.userId;
}

export function requireCurrentUserId(): string {
    const userId = getCurrentUserId();
    if (!userId) {
        throw new MissingAuthContextError();
    }
    return userId;
}
