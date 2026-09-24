import { describe, expect, it, vi } from "vitest";

import { CURATED_TOOLKITS } from "@x/shared/dist/composio.js";
import {
    COMPOSIO_CATALOG_COUNT,
    COMPOSIO_CATALOG_SLUGS,
    ComposioCatalogAdapter,
} from "./composio-catalog.js";

describe("ComposioCatalogAdapter", () => {
    it("exposes all 67 curated toolkits plus composio.execute", () => {
        expect(CURATED_TOOLKITS).toHaveLength(67);
        expect(COMPOSIO_CATALOG_COUNT).toBe(67);
        expect(COMPOSIO_CATALOG_SLUGS).toContain("gmail");
        expect(COMPOSIO_CATALOG_SLUGS).toContain("github");
        const adapter = new ComposioCatalogAdapter({ isConfigured: async () => false });
        expect(adapter.capabilities).toHaveLength(68);
        expect(adapter.capabilities).toContain("composio.execute");
        expect(adapter.capabilities).toContain("composio.gmail");
        expect(adapter.capabilities).toContain("composio.github");
    });

    it("is available only when Composio is configured", async () => {
        const adapter = new ComposioCatalogAdapter({ isConfigured: async () => true });
        await expect(adapter.isAvailable()).resolves.toBe(true);
        const dark = new ComposioCatalogAdapter({ isConfigured: async () => false });
        await expect(dark.isAvailable()).resolves.toBe(false);
    });

    it("rejects toolkits outside the curated catalog", async () => {
        const adapter = new ComposioCatalogAdapter({ isConfigured: async () => true });
        await expect(
            adapter.execute("composio.execute", { toolkitSlug: "not-a-toolkit", toolSlug: "X" }, {}),
        ).resolves.toMatchObject({
            ok: false,
            capability: "composio.execute",
        });
    });

    it("refuses to run until the toolkit has an ACTIVE connected account", async () => {
        const executeAction = vi.fn();
        const adapter = new ComposioCatalogAdapter({
            isConfigured: async () => true,
            getAccount: () => null,
            executeAction,
        });
        const result = await adapter.execute(
            "composio.gmail",
            { toolSlug: "GMAIL_SEND_EMAIL", arguments: { to: "a@b.com" } },
            {},
        );
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/not connected/i);
        expect(executeAction).not.toHaveBeenCalled();
    });

    it("executes a curated toolkit behind the adapter after a connection exists", async () => {
        const executeAction = vi.fn(async () => ({
            data: { id: "msg-1" },
            successful: true,
            error: null,
        }));
        const adapter = new ComposioCatalogAdapter({
            isConfigured: async () => true,
            getAccount: (slug) => (slug === "gmail" ? { id: "ca-1", status: "ACTIVE" } : null),
            executeAction,
        });
        const result = await adapter.execute(
            "composio.gmail",
            { toolSlug: "GMAIL_SEND_EMAIL", arguments: { to: "a@b.com" } },
            {},
        );
        expect(result).toMatchObject({ ok: true, capability: "composio.gmail", data: { id: "msg-1" } });
        expect(executeAction).toHaveBeenCalledWith("GMAIL_SEND_EMAIL", {
            connected_account_id: "ca-1",
            user_id: "rowboat-user",
            version: "latest",
            arguments: { to: "a@b.com" },
        });
    });

    it("does not let composio.gmail run a github tool slug's toolkit", async () => {
        const adapter = new ComposioCatalogAdapter({
            isConfigured: async () => true,
            getAccount: () => ({ id: "ca-1", status: "ACTIVE" }),
            executeAction: async () => ({ data: {}, successful: true, error: null }),
        });
        await expect(
            adapter.execute("composio.gmail", { toolkitSlug: "github", toolSlug: "GITHUB_GET_ME" }, {}),
        ).resolves.toMatchObject({ ok: false });
    });
});
