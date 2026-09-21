import { describe, expect, it } from "vitest";

import { MagicLinkRateLimiter, MemoryRateLimiter } from "./rate-limit.js";

describe("MemoryRateLimiter", () => {
    it("allows up to max hits then blocks until the window resets", () => {
        let now = 1_000;
        const limiter = new MemoryRateLimiter({ windowMs: 1_000, max: 2, now: () => now });
        expect(limiter.hit("a").allowed).toBe(true);
        expect(limiter.hit("a").allowed).toBe(true);
        expect(limiter.hit("a")).toEqual({ allowed: false, retryAfterSec: 1 });
        now = 2_001;
        expect(limiter.hit("a").allowed).toBe(true);
    });
});

describe("MagicLinkRateLimiter", () => {
    it("trips when either the email or the IP exceeds its cap", () => {
        const byEmail = new MagicLinkRateLimiter({
            windowMs: 60_000,
            maxPerEmail: 2,
            maxPerIp: 20,
        });
        expect(byEmail.hit("one@example.com", "1.1.1.1").allowed).toBe(true);
        expect(byEmail.hit("one@example.com", "1.1.1.1").allowed).toBe(true);
        expect(byEmail.hit("one@example.com", "1.1.1.1").allowed).toBe(false);
        expect(byEmail.hit("two@example.com", "1.1.1.1").allowed).toBe(true);

        const byIp = new MagicLinkRateLimiter({
            windowMs: 60_000,
            maxPerEmail: 20,
            maxPerIp: 2,
        });
        expect(byIp.hit("a@example.com", "9.9.9.9").allowed).toBe(true);
        expect(byIp.hit("b@example.com", "9.9.9.9").allowed).toBe(true);
        expect(byIp.hit("c@example.com", "9.9.9.9").allowed).toBe(false);
    });
});
