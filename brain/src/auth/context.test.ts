import { describe, expect, it } from "vitest";

import {
    MissingAuthContextError,
    getCurrentUserId,
    requireCurrentUserId,
    runWithAuthContext,
} from "./context.js";

describe("auth async context", () => {
    it("propagates through an await chain and is absent outside a request", async () => {
        expect(getCurrentUserId()).toBeUndefined();
        expect(() => requireCurrentUserId()).toThrow(MissingAuthContextError);

        const seen: Array<string | undefined> = [];
        await runWithAuthContext({ userId: "user-1", via: "session" }, async () => {
            seen.push(getCurrentUserId());
            await Promise.resolve();
            seen.push(getCurrentUserId());
            await new Promise((resolve) => setTimeout(resolve, 5));
            expect(requireCurrentUserId()).toBe("user-1");
        });

        expect(seen).toEqual(["user-1", "user-1"]);
        expect(getCurrentUserId()).toBeUndefined();
        expect(() => requireCurrentUserId()).toThrow(/No authenticated user/);
    });

    it("does not leak across concurrent requests", async () => {
        const a = runWithAuthContext({ userId: "a", via: "session" }, async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
            return getCurrentUserId();
        });
        const b = runWithAuthContext({ userId: "b", via: "static_token" }, async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return getCurrentUserId();
        });
        expect(await Promise.all([a, b])).toEqual(["a", "b"]);
        expect(getCurrentUserId()).toBeUndefined();
    });
});
