import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpDir: string;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function writeApiKey(apiKey = "test-key"): void {
    const configDir = path.join(tmpDir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, "composio.json"),
        JSON.stringify({ apiKey }, null, 2),
    );
}

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rowboat-composio-test-"));
    process.env.ROWBOAT_WORKDIR = tmpDir;
    writeApiKey();
    vi.resetModules();
    vi.doMock("../account/account.js", () => ({
        isSignedIn: vi.fn(async () => false),
    }));
    vi.doMock("../auth/tokens.js", () => ({
        getAccessToken: vi.fn(async () => "access-token"),
    }));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    delete process.env.ROWBOAT_WORKDIR;
    vi.doUnmock("../account/account.js");
    vi.doUnmock("../auth/tokens.js");
    vi.unstubAllGlobals();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadClient() {
    return import("./client.js");
}

describe("linkConnectedAccount", () => {
    it("POSTs /connected_accounts/link with flat body and API key", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                {
                    connected_account_id: "ca_123",
                    redirect_url: "https://connect.example/oauth",
                    link_token: "lt_abc",
                    expires_at: "2026-08-25T12:00:00.000Z",
                },
                201,
            ),
        );

        const client = await loadClient();
        await client.linkConnectedAccount({
            auth_config_id: "ac_managed",
            user_id: "rowboat-user",
            callback_url: "http://localhost:8081/oauth/callback",
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
        expect(String(url)).toBe(
            "https://backend.composio.dev/api/v3/connected_accounts/link",
        );
        expect(init.method).toBe("POST");
        expect(init.headers).toMatchObject({
            "x-api-key": "test-key",
            "Content-Type": "application/json",
        });
        expect(JSON.parse(String(init.body))).toEqual({
            auth_config_id: "ac_managed",
            user_id: "rowboat-user",
            callback_url: "http://localhost:8081/oauth/callback",
        });
    });

    it("parses a full 201 link response", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                {
                    connected_account_id: "ca_123",
                    redirect_url: "https://connect.example/oauth",
                    link_token: "lt_abc",
                    expires_at: "2026-08-25T12:00:00.000Z",
                },
                201,
            ),
        );

        const client = await loadClient();
        const result = await client.linkConnectedAccount({
            auth_config_id: "ac_managed",
            user_id: "rowboat-user",
        });

        expect(result).toEqual({
            connected_account_id: "ca_123",
            redirect_url: "https://connect.example/oauth",
            link_token: "lt_abc",
            expires_at: "2026-08-25T12:00:00.000Z",
        });
    });

    it("accepts a response without optional link_token/expires_at", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                {
                    connected_account_id: "ca_min",
                    redirect_url: "https://connect.example/min",
                },
                201,
            ),
        );

        const client = await loadClient();
        const result = await client.linkConnectedAccount({
            auth_config_id: "ac_managed",
            user_id: "rowboat-user",
        });

        expect(result).toEqual({
            connected_account_id: "ca_min",
            redirect_url: "https://connect.example/min",
        });
    });

    it("rejects a success body missing redirect_url", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({ connected_account_id: "ca_bad" }, 201),
        );

        const client = await loadClient();
        await expect(
            client.linkConnectedAccount({
                auth_config_id: "ac_managed",
                user_id: "rowboat-user",
            }),
        ).rejects.toThrow();
    });

    it("surfaces 400 errors from the Composio API", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                {
                    error: {
                        message:
                            "Creating connections on this endpoint for Composio-managed OAuth auth configs is no longer supported. Use POST /api/v3/connected_accounts/link instead.",
                        code: 600,
                        slug: "ConnectedAccount_BadRequest",
                    },
                },
                400,
            ),
        );

        const client = await loadClient();
        await expect(
            client.linkConnectedAccount({
                auth_config_id: "ac_managed",
                user_id: "rowboat-user",
            }),
        ).rejects.toThrow(/Composio API error: 400/);
    });

    it("always uses Composio directly even if isSignedIn is mocked true", async () => {
        // Hosted proxy removed — signed-in users no longer exist. This test
        // documents that Composio always hits backend.composio.dev with an API key.
        vi.resetModules();
        vi.doMock("../account/account.js", () => ({
            isSignedIn: vi.fn(async () => true),
        }));
        vi.doMock("../auth/tokens.js", () => ({
            getAccessToken: vi.fn(async () => "access-token"),
        }));

        fetchMock.mockResolvedValueOnce(
            jsonResponse(
                {
                    connected_account_id: "ca_proxy",
                    redirect_url: "https://connect.example/proxy",
                },
                201,
            ),
        );

        const client = await loadClient();
        await client.linkConnectedAccount({
            auth_config_id: "ac_managed",
            user_id: "rowboat-user",
            callback_url: "http://localhost:8081/oauth/callback",
        });

        const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
        expect(String(url)).toBe(
            "https://backend.composio.dev/api/v3/connected_accounts/link",
        );
        expect(init.headers).toMatchObject({
            "x-api-key": "test-key",
            "Content-Type": "application/json",
        });
    });
});

describe("createConnectedAccount", () => {
    it("still POSTs /connected_accounts with the legacy nested body", async () => {
        fetchMock.mockResolvedValueOnce(
            jsonResponse({
                id: "ca_legacy",
                connectionData: {
                    authScheme: "OAUTH2",
                    val: { status: "INITIATED", redirectUrl: "https://example/redirect" },
                },
            }),
        );

        const client = await loadClient();
        await client.createConnectedAccount({
            auth_config: { id: "ac_custom" },
            connection: {
                user_id: "rowboat-user",
                callback_url: "http://localhost:8081/oauth/callback",
            },
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
        expect(String(url)).toBe(
            "https://backend.composio.dev/api/v3/connected_accounts",
        );
        expect(init.method).toBe("POST");
        expect(JSON.parse(String(init.body))).toEqual({
            auth_config: { id: "ac_custom" },
            connection: {
                user_id: "rowboat-user",
                callback_url: "http://localhost:8081/oauth/callback",
            },
        });
    });
});
