export const DEFAULT_TRUSTED_PROXY_HOPS = 0;

export function readTrustedProxyHops(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.BRAIN_TRUSTED_PROXY_HOPS;
    if (raw === undefined || raw === "") {
        return DEFAULT_TRUSTED_PROXY_HOPS;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return DEFAULT_TRUSTED_PROXY_HOPS;
    }
    return parsed;
}

/**
 * Client IP for rate limits. X-Forwarded-For is only consulted for the
 * configured number of trusted proxy hops, counting from the right (the
 * nearest proxy). With hops=0 the socket address wins, so a client cannot
 * spoof the limiter. Render sits one hop in front of the app: set
 * BRAIN_TRUSTED_PROXY_HOPS=1.
 */
export function clientIpFromForwarded(
    forwarded: string | undefined,
    remoteAddress: string | undefined,
    trustedHops: number,
): string {
    const remote = remoteAddress?.trim() || "unknown";
    const forwardedHops = (forwarded ?? "")
        .split(",")
        .map((hop) => hop.trim())
        .filter(Boolean);
    const chain = [...forwardedHops, remote];
    const hops = Number.isFinite(trustedHops) && trustedHops > 0 ? Math.floor(trustedHops) : 0;
    const index = Math.max(0, chain.length - 1 - hops);
    return chain[index] || remote;
}
