import { CURATED_TOOLKITS, CURATED_TOOLKIT_SLUGS } from "@x/shared/dist/composio.js";
import { executeAction as executeComposioAction, isConfigured as isComposioConfigured } from "../../../composio/client.js";
import { composioAccountsRepo } from "../../../composio/repo.js";
import type { ConnectedAccountStatus } from "../../../composio/types.js";
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "../types.js";

export const COMPOSIO_CATALOG_COUNT = CURATED_TOOLKITS.length;

export const COMPOSIO_CATALOG_SLUGS: readonly string[] = CURATED_TOOLKITS.map((toolkit) => toolkit.slug);

export const COMPOSIO_CATALOG_CAPABILITIES: readonly string[] = [
    "composio.execute",
    ...COMPOSIO_CATALOG_SLUGS.map((slug) => `composio.${slug}`),
];

export type ComposioCatalogAccount = { id: string; status: ConnectedAccountStatus };

export type ComposioCatalogDeps = {
    isConfigured?: () => Promise<boolean>;
    getAccount?: (toolkitSlug: string) => ComposioCatalogAccount | null;
    executeAction?: (
        toolSlug: string,
        request: {
            connected_account_id: string;
            user_id: string;
            version: string;
            arguments?: Record<string, unknown>;
        },
    ) => Promise<{ data: unknown; successful: boolean; error: string | null }>;
};

function asString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toolkitFromCapability(capability: string): string | undefined {
    if (capability === "composio.execute") return undefined;
    if (capability.startsWith("composio.")) return capability.slice("composio.".length);
    return undefined;
}

/**
 * All 67 curated Composio toolkits as operator capabilities, executed only
 * after the existing approval-gated executor (and chat `composio-execute`
 * permission) lets the action through. Catalog membership is not the same as
 * 67 live OAuth sessions — `isAvailable` is the Composio API key; each slug
 * still needs an ACTIVE connected account to run.
 */
export class ComposioCatalogAdapter implements CapabilityAdapter {
    readonly id = "composio-catalog";
    readonly capabilities = [...COMPOSIO_CATALOG_CAPABILITIES];

    private readonly isConfigured: () => Promise<boolean>;
    private readonly getAccount: (toolkitSlug: string) => ComposioCatalogAccount | null;
    private readonly executeAction: NonNullable<ComposioCatalogDeps["executeAction"]>;

    constructor(deps: ComposioCatalogDeps = {}) {
        this.isConfigured = deps.isConfigured ?? isComposioConfigured;
        this.getAccount = deps.getAccount ?? ((slug) => composioAccountsRepo.getAccount(slug));
        this.executeAction =
            deps.executeAction ??
            (async (toolSlug, request) => executeComposioAction(toolSlug, request));
    }

    async isAvailable(): Promise<boolean> {
        return this.isConfigured();
    }

    async execute(capability: string, args: Record<string, unknown>, _ctx: CapabilityContext): Promise<CapabilityResult> {
        if (!this.capabilities.includes(capability)) {
            return { ok: false, capability, error: `Capability ${capability} is not supported by ${this.id}.` };
        }

        if (!(await this.isAvailable())) {
            return {
                ok: false,
                capability,
                unavailable: true,
                error: "Composio catalog adapter requires a Composio API key.",
            };
        }

        const fromCapability = toolkitFromCapability(capability);
        const toolkitSlug = asString(args.toolkitSlug) ?? fromCapability;
        const toolSlug = asString(args.toolSlug) ?? asString(args.action);

        if (!toolkitSlug) {
            return {
                ok: false,
                capability,
                error: 'toolkitSlug is required (e.g. "gmail") when using composio.execute.',
            };
        }
        if (!CURATED_TOOLKIT_SLUGS.has(toolkitSlug)) {
            return {
                ok: false,
                capability,
                error: `Toolkit "${toolkitSlug}" is not in the curated Composio catalog (${COMPOSIO_CATALOG_COUNT} connectors).`,
            };
        }
        if (fromCapability && fromCapability !== toolkitSlug) {
            return {
                ok: false,
                capability,
                error: `Capability ${capability} cannot execute toolkit "${toolkitSlug}".`,
            };
        }
        if (!toolSlug) {
            return { ok: false, capability, error: "toolSlug is required." };
        }

        const account = this.getAccount(toolkitSlug);
        if (!account || account.status !== "ACTIVE") {
            return {
                ok: false,
                capability,
                error: `Toolkit "${toolkitSlug}" is not connected. Connect it first; the catalog is approval-gated, not 67 live OAuth sessions.`,
            };
        }

        const toolArgs =
            args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
                ? (args.arguments as Record<string, unknown>)
                : {};

        try {
            const result = await this.executeAction(toolSlug, {
                connected_account_id: account.id,
                user_id: "rowboat-user",
                version: "latest",
                arguments: toolArgs,
            });
            if (!result.successful) {
                return {
                    ok: false,
                    capability,
                    error: result.error ?? `Composio tool ${toolSlug} failed.`,
                    data: result.data,
                };
            }
            return { ok: true, capability, data: result.data };
        } catch (error) {
            return {
                ok: false,
                capability,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }
}
