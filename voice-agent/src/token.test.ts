import { describe, expect, it } from "vitest";
import { AGENT_NAME } from "./constants.js";
import { mintAccessToken, verifyAccessToken } from "./token.js";
import { parseTokenRequest } from "./token-server.js";

const creds = {
  apiKey: "devkey",
  apiSecret: "test-secret-test-secret-test-secret",
  serverUrl: "wss://example.livekit.cloud",
};

describe("mintAccessToken", () => {
  it("mints a join token with room grants and language attributes", async () => {
    const minted = await mintAccessToken(
      {
        roomName: "dialy-call-1",
        identity: "user-42",
        name: "Dhruv",
        language: "hi",
      },
      creds,
    );

    expect(minted.serverUrl).toBe(creds.serverUrl);
    expect(minted.language).toBe("hi-IN");
    expect(minted.roomName).toBe("dialy-call-1");

    const claims = await verifyAccessToken(minted.token, creds);
    expect(claims.sub).toBe("user-42");
    expect(claims.video?.roomJoin).toBe(true);
    expect(claims.video?.room).toBe("dialy-call-1");
    expect(claims.video?.canPublish).toBe(true);
    expect(claims.video?.canSubscribe).toBe(true);
    expect(claims.attributes?.language).toBe("hi-IN");
    expect(claims.attributes?.["user.language"]).toBe("hi-IN");
  });

  it("defaults language to gu-IN", async () => {
    const minted = await mintAccessToken(
      { roomName: "r", identity: "u" },
      creds,
    );
    expect(minted.language).toBe("gu-IN");
    const claims = await verifyAccessToken(minted.token, creds);
    expect(claims.attributes?.language).toBe("gu-IN");
  });

  it("dispatches the dialy-voice agent", async () => {
    const minted = await mintAccessToken(
      { roomName: "r", identity: "u", language: "en-IN" },
      creds,
    );
    const claims = await verifyAccessToken(minted.token, creds);
    const agents = claims.roomConfig?.agents ?? [];
    expect(agents.length).toBeGreaterThan(0);
    expect(agents[0]?.agentName).toBe(AGENT_NAME);
  });
});

describe("parseTokenRequest", () => {
  it("reads LiveKit-standard body fields", () => {
    const parsed = parseTokenRequest(
      {
        room_name: "room-a",
        participant_identity: "p1",
        participant_name: "Priya",
        language: "gu-IN",
      },
      new URLSearchParams(),
    );
    expect(parsed.roomName).toBe("room-a");
    expect(parsed.identity).toBe("p1");
    expect(parsed.name).toBe("Priya");
    expect(parsed.language).toBe("gu-IN");
  });

  it("falls back to query parameters", () => {
    const parsed = parseTokenRequest(
      {},
      new URLSearchParams({ room: "r2", identity: "i2", language: "hi-IN" }),
    );
    expect(parsed.roomName).toBe("r2");
    expect(parsed.identity).toBe("i2");
    expect(parsed.language).toBe("hi-IN");
  });
});
