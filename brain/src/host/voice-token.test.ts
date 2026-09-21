import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { requireOperatorUserId } from "./operator-boot.js";
import {
    DEFAULT_CALL_LANGUAGE,
    mintVoiceAccessToken,
    parseCallLanguage,
    parseVoiceTokenRequest,
    readLiveKitCredentials,
    verifyVoiceAccessToken,
    VOICE_AGENT_NAME,
    VoiceTokenConfigError,
} from "./voice-token.js";

const LIVEKIT_KEYS = ["LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "DIALY_DEFAULT_USER_ID"] as const;

function snapshotEnv(): Record<(typeof LIVEKIT_KEYS)[number], string | undefined> {
    const out = {} as Record<(typeof LIVEKIT_KEYS)[number], string | undefined>;
    for (const key of LIVEKIT_KEYS) {
        out[key] = process.env[key];
    }
    return out;
}

function restoreEnv(snapshot: Record<(typeof LIVEKIT_KEYS)[number], string | undefined>): void {
    for (const key of LIVEKIT_KEYS) {
        const value = snapshot[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

const creds = {
    apiKey: "devkey",
    apiSecret: "test-secret-test-secret-test-secret",
    serverUrl: "wss://example.livekit.cloud",
};

describe("requireOperatorUserId", () => {
    let env: ReturnType<typeof snapshotEnv>;

    beforeEach(() => {
        env = snapshotEnv();
        delete process.env.DIALY_DEFAULT_USER_ID;
    });

    afterEach(() => {
        restoreEnv(env);
    });

    it("throws instead of letting the executor silently skip the trust ledger", () => {
        expect(() => requireOperatorUserId()).toThrow(/trust ledger requires a userId/);
    });

    it("accepts DIALY_DEFAULT_USER_ID when no request auth context exists", () => {
        process.env.DIALY_DEFAULT_USER_ID = "user-ca";
        expect(requireOperatorUserId()).toBe("user-ca");
    });
});

describe("mintVoiceAccessToken", () => {
    it("mirrors the worker claims: language attributes and dialy-voice dispatch", async () => {
        const minted = await mintVoiceAccessToken(
            {
                roomName: "dialy-call-1",
                identity: "user-42",
                language: "hi",
                attributes: { sessionId: "sess-1" },
            },
            creds,
        );

        expect(minted.language).toBe("hi-IN");
        expect(minted.serverUrl).toBe(creds.serverUrl);

        const claims = await verifyVoiceAccessToken(minted.token, creds);
        expect(claims.sub).toBe("user-42");
        expect(claims.video?.roomJoin).toBe(true);
        expect(claims.video?.room).toBe("dialy-call-1");
        expect(claims.video?.canPublish).toBe(true);
        expect(claims.video?.canSubscribe).toBe(true);
        expect(claims.attributes?.language).toBe("hi-IN");
        expect(claims.attributes?.["user.language"]).toBe("hi-IN");
        expect(claims.attributes?.sessionId).toBe("sess-1");
        const agents = claims.roomConfig?.agents ?? [];
        expect(agents[0]?.agentName).toBe(VOICE_AGENT_NAME);
    });

    it("defaults language to gu-IN", async () => {
        const minted = await mintVoiceAccessToken({ roomName: "r", identity: "u" }, creds);
        expect(minted.language).toBe(DEFAULT_CALL_LANGUAGE);
        expect(parseCallLanguage("en")).toBe("en-IN");
    });
});

describe("parseVoiceTokenRequest", () => {
    it("reads the web client body shape", () => {
        const parsed = parseVoiceTokenRequest({
            room_name: "room-a",
            participant_identity: "p1",
            language: "gu-IN",
            sessionId: "s1",
            participant_attributes: { language: "gu-IN" },
        });
        expect(parsed).toMatchObject({
            roomName: "room-a",
            identity: "p1",
            language: "gu-IN",
            attributes: { language: "gu-IN", sessionId: "s1" },
        });
    });

    it("requires room_name and participant_identity", () => {
        expect(parseVoiceTokenRequest({})).toEqual({
            error: "Body must include room_name and participant_identity.",
        });
    });
});

describe("readLiveKitCredentials", () => {
    let env: ReturnType<typeof snapshotEnv>;

    beforeEach(() => {
        env = snapshotEnv();
        delete process.env.LIVEKIT_URL;
        delete process.env.LIVEKIT_API_KEY;
        delete process.env.LIVEKIT_API_SECRET;
    });

    afterEach(() => {
        restoreEnv(env);
    });

    it("fails closed when LiveKit env is missing", () => {
        expect(() => readLiveKitCredentials()).toThrow(VoiceTokenConfigError);
    });
});
