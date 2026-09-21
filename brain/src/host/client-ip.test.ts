import { describe, expect, it } from "vitest";

import { clientIpFromForwarded, DEFAULT_TRUSTED_PROXY_HOPS, readTrustedProxyHops } from "./client-ip.js";

describe("clientIpFromForwarded", () => {
    it("ignores X-Forwarded-For when no proxy hops are trusted", () => {
        expect(
            clientIpFromForwarded("9.9.9.9, 8.8.8.8", "127.0.0.1", 0),
        ).toBe("127.0.0.1");
        expect(DEFAULT_TRUSTED_PROXY_HOPS).toBe(0);
        expect(readTrustedProxyHops({})).toBe(0);
    });

    it("uses the rightmost untrusted hop behind one reverse proxy", () => {
        expect(clientIpFromForwarded("9.9.9.9, 203.0.113.10", "10.0.0.2", 1)).toBe("203.0.113.10");
        expect(clientIpFromForwarded("203.0.113.10", "10.0.0.2", 1)).toBe("203.0.113.10");
    });

    it("does not let a spoofed leftmost entry win behind Render (one hop)", () => {
        expect(clientIpFromForwarded("1.2.3.4, 198.51.100.20", "10.0.0.2", 1)).toBe("198.51.100.20");
    });
});

describe("readTrustedProxyHops", () => {
    it("parses BRAIN_TRUSTED_PROXY_HOPS and rejects junk", () => {
        expect(readTrustedProxyHops({ BRAIN_TRUSTED_PROXY_HOPS: "1" })).toBe(1);
        expect(readTrustedProxyHops({ BRAIN_TRUSTED_PROXY_HOPS: "2" })).toBe(2);
        expect(readTrustedProxyHops({ BRAIN_TRUSTED_PROXY_HOPS: "-1" })).toBe(0);
        expect(readTrustedProxyHops({ BRAIN_TRUSTED_PROXY_HOPS: "nope" })).toBe(0);
    });
});
