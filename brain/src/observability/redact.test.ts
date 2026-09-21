import { afterEach, describe, expect, it } from "vitest";

import { redactForTrace, resolveTraceRedactMode } from "./redact.js";

describe("resolveTraceRedactMode", () => {
    it("defaults to strict", () => {
        expect(resolveTraceRedactMode({})).toBe("strict");
        expect(resolveTraceRedactMode({ DIALY_TRACE_REDACT: "keys" })).toBe("keys");
        expect(resolveTraceRedactMode({ DIALY_TRACE_REDACT: "off" })).toBe("off");
    });
});

describe("redactForTrace", () => {
    const secretPayload = {
        sessionId: "session-1",
        turnId: "turn-1",
        userId: "user-1",
        apiKey: "sk-live-secret",
        token: "magic-link-token",
        authorization: "Bearer abc",
        magicLink: "https://dialy.example/login?token=abc",
        password: "hunter2",
        body: "Dear client, your GSTIN is 27AAPFU0939F1ZV and the return is attached.",
        pan: "ABCDE1234F",
        to: "ca.client@example.com",
        capability: "mail.send",
    };

    it("never emits credentials, even when PII redaction is off", () => {
        const redacted = redactForTrace(secretPayload, "off") as Record<string, unknown>;
        expect(redacted.apiKey).toMatch(/^\[redacted\]/);
        expect(redacted.token).toMatch(/^\[redacted\]/);
        expect(redacted.authorization).toMatch(/^\[redacted\]/);
        expect(redacted.magicLink).toMatch(/^\[redacted\]/);
        expect(redacted.password).toMatch(/^\[redacted\]/);
        expect(redacted.sessionId).toBe("session-1");
        expect(redacted.turnId).toBe("turn-1");
        expect(redacted.body).toBe(secretPayload.body);
    });

    it("in strict mode also strips email bodies, identifiers, and addresses", () => {
        const redacted = redactForTrace(secretPayload, "strict") as Record<string, unknown>;
        expect(String(redacted.body)).toMatch(/^\[redacted\]/);
        expect(String(redacted.pan)).toMatch(/^\[redacted\]/);
        expect(String(redacted.to)).toMatch(/^\[redacted\]/);
        expect(redacted.sessionId).toBe("session-1");
        expect(redacted.userId).toBe("user-1");
        expect(redacted.capability).toBe("mail.send");
        expect(JSON.stringify(redacted)).not.toContain("sk-live-secret");
        expect(JSON.stringify(redacted)).not.toContain("GSTIN");
        expect(JSON.stringify(redacted)).not.toContain("ca.client@example.com");
    });

    it("redacts nested tool arguments and secret-shaped values", () => {
        const redacted = redactForTrace(
            {
                toolName: "gmail.send",
                arguments: {
                    body: "ITR draft for FY 24-25",
                    COMPOSIO_API_KEY: "ck_123",
                    note: "contact me at founder@firm.in about aadhaar 1234 5678 9012",
                },
            },
            "strict",
        ) as { arguments: Record<string, unknown> };
        expect(redacted.arguments.body).toBe("[redacted]:22");
        expect(redacted.arguments.COMPOSIO_API_KEY).toBe("[redacted]:6");
        expect(String(redacted.arguments.note)).toMatch(/^\[redacted\]/);
    });

    it("in keys mode keeps CA financial text but still strips secrets", () => {
        const redacted = redactForTrace(secretPayload, "keys") as Record<string, unknown>;
        expect(redacted.body).toBe(secretPayload.body);
        expect(redacted.apiKey).toBe("[redacted]:14");
    });
});
