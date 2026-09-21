export type RateLimitHit = {
    allowed: boolean;
    retryAfterSec: number;
};

type Bucket = {
    count: number;
    resetAt: number;
};

export type RateLimiterOptions = {
    windowMs: number;
    max: number;
    now?: () => number;
};

export class MemoryRateLimiter {
    private readonly windowMs: number;
    private readonly max: number;
    private readonly now: () => number;
    private readonly buckets = new Map<string, Bucket>();

    constructor(options: RateLimiterOptions) {
        this.windowMs = options.windowMs;
        this.max = options.max;
        this.now = options.now ?? Date.now;
    }

    hit(key: string): RateLimitHit {
        const now = this.now();
        this.prune(now);
        const bucket = this.buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
            return { allowed: true, retryAfterSec: 0 };
        }
        if (bucket.count >= this.max) {
            return {
                allowed: false,
                retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
            };
        }
        bucket.count += 1;
        return { allowed: true, retryAfterSec: 0 };
    }

    private prune(now: number): void {
        if (this.buckets.size < 512) {
            return;
        }
        for (const [key, bucket] of this.buckets) {
            if (bucket.resetAt <= now) {
                this.buckets.delete(key);
            }
        }
    }
}

export const MAGIC_LINK_WINDOW_MS = 15 * 60 * 1000;
export const MAGIC_LINK_MAX_PER_EMAIL = 5;
export const MAGIC_LINK_MAX_PER_IP = 20;

export type MagicLinkLimiterOptions = {
    windowMs?: number;
    maxPerEmail?: number;
    maxPerIp?: number;
    now?: () => number;
};

export class MagicLinkRateLimiter {
    private readonly email: MemoryRateLimiter;
    private readonly ip: MemoryRateLimiter;

    constructor(options: MagicLinkLimiterOptions = {}) {
        const windowMs = options.windowMs ?? MAGIC_LINK_WINDOW_MS;
        const now = options.now;
        this.email = new MemoryRateLimiter({
            windowMs,
            max: options.maxPerEmail ?? MAGIC_LINK_MAX_PER_EMAIL,
            now,
        });
        this.ip = new MemoryRateLimiter({
            windowMs,
            max: options.maxPerIp ?? MAGIC_LINK_MAX_PER_IP,
            now,
        });
    }

    hit(email: string, ip: string): RateLimitHit {
        const byEmail = this.email.hit(`email:${email}`);
        const byIp = this.ip.hit(`ip:${ip}`);
        if (!byEmail.allowed) {
            return byEmail;
        }
        if (!byIp.allowed) {
            return byIp;
        }
        return { allowed: true, retryAfterSec: 0 };
    }
}
