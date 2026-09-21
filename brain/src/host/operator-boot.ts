import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WorkDir } from "../config/config.js";
import { FileApprovalsStore, type ApprovalsStore } from "../operator/approvals.js";
import { CalendarAdapter } from "../operator/capabilities/adapters/calendar.js";
import { GitHubCodeAdapter } from "../operator/capabilities/adapters/code-github.js";
import { RenderDeployAdapter } from "../operator/capabilities/adapters/deploy-render.js";
import { JournalLogAdapter } from "../operator/capabilities/adapters/journal-log.js";
import { MailAdapter } from "../operator/capabilities/adapters/mail-composio.js";
import { ConsoleNotifySink, NotifyAdapter, TelegramNotifySink } from "../operator/capabilities/adapters/notify.js";
import { CapabilityRegistry } from "../operator/capabilities/registry.js";
import { processSignal } from "../operator/engine.js";
import { executeEngineResult, type ExecutionSummary } from "../operator/executor.js";
import { Journal } from "../operator/journal.js";
import {
    getPlaybookLoadErrors,
    listPlaybooks,
    loadPlaybooksFromDir,
} from "../operator/playbooks/loader.js";
import { OperatorScheduler } from "../operator/scheduler.js";
import { SignalSchema, type ActionRequest, type Signal } from "../operator/types.js";
import { hostLog } from "./logger.js";
import {
    FailureStreaks,
    WebhookDeduper,
    normalizeGitHubEvent,
    normalizeRenderEvent,
    verifyGitHubSignature,
    verifyRenderSignature,
    type NormalizedWebhook,
} from "./webhooks.js";

type PublicAction = Pick<ActionRequest, "id" | "playbookId" | "capability" | "mode" | "signalId" | "status">;

type PublicEngineResult = {
    signalId: string;
    matches: Array<{
        playbookId: string;
        triage: {
            class: string;
            reason: string;
            confidence?: number;
            via: string;
        };
        decision: {
            class: string;
            reason: string;
        };
        actions: PublicAction[];
    }>;
    execution?: ExecutionSummary;
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const packagedPlaybooksDir = path.resolve(moduleDir, "../../playbooks");
const workPlaybooksDir = path.join(WorkDir, "playbooks");
const journal = new Journal(path.join(WorkDir, "logs", "operator.jsonl"));
const approvals: ApprovalsStore = new FileApprovalsStore(path.join(WorkDir, "storage", "approvals.json"));
const registry = new CapabilityRegistry();
const telegramNotify = new TelegramNotifySink();

const failureStreaks = new FailureStreaks();
const webhookDeduper = new WebhookDeduper();

// Action ids are namespaced per boot so persisted approvals from an earlier
// process can never collide with ids minted after a restart.
const bootId = randomUUID().slice(0, 8);
let nextActionId = 1;
let booted = false;
let scheduler: OperatorScheduler | undefined;

function isPlaybookFile(name: string): boolean {
    return [".json", ".yaml", ".yml"].includes(path.extname(name).toLowerCase());
}

function hasPlaybookFiles(dir: string): boolean {
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isFile() && isPlaybookFile(entry.name));
}

function seedPlaybooks(): void {
    fs.mkdirSync(workPlaybooksDir, { recursive: true });
    if (hasPlaybookFiles(workPlaybooksDir)) return;
    if (!fs.existsSync(packagedPlaybooksDir)) {
        hostLog.warn("operator packaged playbooks not found", { packagedPlaybooksDir });
        return;
    }
    for (const entry of fs.readdirSync(packagedPlaybooksDir, { withFileTypes: true })) {
        if (!entry.isFile() || !isPlaybookFile(entry.name)) continue;
        const target = path.join(workPlaybooksDir, entry.name);
        if (!fs.existsSync(target)) {
            fs.copyFileSync(path.join(packagedPlaybooksDir, entry.name), target);
        }
    }
    hostLog.info("operator seeded playbooks", { from: packagedPlaybooksDir, to: workPlaybooksDir });
}

function registerCapabilities(): void {
    registry
        .register(new RenderDeployAdapter())
        .register(new GitHubCodeAdapter())
        .register(new MailAdapter())
        .register(new CalendarAdapter())
        .register(new JournalLogAdapter(journal))
        .register(new NotifyAdapter([new ConsoleNotifySink(), telegramNotify]));
}

function normalizeSignal(input: unknown): Signal {
    const base = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    return SignalSchema.parse({
        id: typeof base.id === "string" && base.id ? base.id : `signal-${Date.now()}`,
        source: base.source,
        type: base.type,
        createdAt:
            typeof base.createdAt === "string" && base.createdAt
                ? base.createdAt
                : new Date().toISOString(),
        payload: base.payload && typeof base.payload === "object" ? base.payload : {},
        raw: base.raw,
    });
}

function toPublicAction(action: ActionRequest): PublicAction {
    return {
        id: action.id,
        playbookId: action.playbookId,
        capability: action.capability,
        mode: action.mode,
        signalId: action.signalId,
        status: action.status,
    };
}

export function bootOperator(): void {
    if (booted) return;
    seedPlaybooks();
    registerCapabilities();
    const sourceDir = hasPlaybookFiles(workPlaybooksDir) ? workPlaybooksDir : packagedPlaybooksDir;
    const playbooks = loadPlaybooksFromDir(sourceDir);
    hostLog.info("operator playbooks loaded", {
        sourceDir,
        count: playbooks.length,
        errors: getPlaybookLoadErrors().length,
    });
    booted = true;
    startScheduler();
}

function startScheduler(): void {
    if (scheduler || process.env.OPERATOR_SCHEDULER === "off") return;
    scheduler = new OperatorScheduler({
        listPlaybooks: () => listPlaybooks(),
        emit: (signal) => handleOperatorSignal(signal),
        runProbe: (capability, args) => registry.execute(capability, args, {}),
        onError: (message, meta) => hostLog.warn(message, meta),
    });
    scheduler.start();
    hostLog.info("operator scheduler started");
}

export function stopOperatorScheduler(): void {
    scheduler?.stop();
    scheduler = undefined;
}

export function getOperatorPlaybooks(): Array<{ id: string; title: string; enabled: boolean }> {
    return listPlaybooks().map((playbook) => ({
        id: playbook.id,
        title: playbook.title,
        enabled: playbook.enabled,
    }));
}

export async function getOperatorApprovals() {
    return approvals.listPending();
}

export function getOperatorPlaybookErrors(): Array<{ file: string; message: string }> {
    return getPlaybookLoadErrors();
}

export type OperatorCapabilityStatus = {
    id: string;
    capabilities: string[];
    available: boolean;
};

export type OperatorAdapterFlags = {
    render: boolean;
    github: boolean;
    mail: boolean;
    calendar: boolean;
    notify: boolean;
    telegram: boolean;
};

export async function getOperatorCapabilities(): Promise<{
    adapters: OperatorCapabilityStatus[];
    flags: OperatorAdapterFlags;
}> {
    if (!booted) bootOperator();
    const adapters: OperatorCapabilityStatus[] = [];
    for (const adapter of registry.listAdapters()) {
        adapters.push({
            id: adapter.id,
            capabilities: [...adapter.capabilities],
            available: await adapter.isAvailable(),
        });
    }
    const byId = Object.fromEntries(adapters.map((a) => [a.id, a.available]));
    const flags: OperatorAdapterFlags = {
        render: Boolean(byId["deploy-render"]),
        github: Boolean(byId["code-github"]),
        mail: Boolean(byId["mail-composio"]),
        calendar: Boolean(byId["calendar"]),
        notify: Boolean(byId["notify"]),
        telegram: await telegramNotify.isAvailable(),
    };
    return { adapters, flags };
}

export async function handleOperatorSignal(input: unknown): Promise<PublicEngineResult> {
    if (!booted) bootOperator();
    const signal = normalizeSignal(input);
    const result = await processSignal(signal, listPlaybooks(), {
        journal,
        capabilities: registry,
        createActionId: () => `operator-action-${bootId}-${nextActionId++}`,
    });

    const execution = await executeEngineResult(result, registry, approvals, journal);

    const matches = result.matches.map((match) => ({
        playbookId: match.playbookId,
        triage: match.triage,
        decision: {
            class: match.decision.class,
            reason: match.decision.reason,
        },
        actions: match.actions.map(toPublicAction),
    }));

    return {
        signalId: result.signalId,
        matches,
        execution,
    };
}

export type WebhookVendor = "render" | "github";

export type WebhookIngestResult = {
    status: number;
    body: Record<string, unknown>;
};

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
    const raw = headers[name];
    return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Verifies, normalizes and queues an inbound vendor webhook.
 *
 * Vendors retry any response that is not 2xx within 15s, so the signal is
 * processed after the response is returned rather than inline.
 */
export async function ingestOperatorWebhook(
    vendor: WebhookVendor,
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
): Promise<WebhookIngestResult> {
    if (!booted) bootOperator();

    const secret = vendor === "render" ? process.env.RENDER_WEBHOOK_SECRET : process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
        const envName = vendor === "render" ? "RENDER_WEBHOOK_SECRET" : "GITHUB_WEBHOOK_SECRET";
        return { status: 503, body: { error: "webhook_not_configured", message: `${envName} is not set.` } };
    }

    const verification =
        vendor === "render"
            ? verifyRenderSignature({
                  secret,
                  id: headerValue(headers, "webhook-id"),
                  timestamp: headerValue(headers, "webhook-timestamp"),
                  signature: headerValue(headers, "webhook-signature"),
                  rawBody,
              })
            : verifyGitHubSignature(secret, headerValue(headers, "x-hub-signature-256"), rawBody);

    if (!verification.ok) {
        hostLog.warn("operator webhook rejected", { vendor, reason: verification.reason });
        return { status: 401, body: { error: "invalid_signature", message: verification.reason } };
    }

    let parsed: unknown;
    try {
        parsed = rawBody.trim() ? JSON.parse(rawBody) : {};
    } catch (error) {
        return {
            status: 400,
            body: { error: "invalid_json", message: error instanceof Error ? error.message : String(error) },
        };
    }

    const normalized: NormalizedWebhook | null =
        vendor === "render"
            ? normalizeRenderEvent(parsed)
            : normalizeGitHubEvent(headerValue(headers, "x-github-event"), parsed);

    if (!normalized) {
        return { status: 200, body: { ok: true, ignored: true, reason: "event is not operator-relevant" } };
    }

    const deliveryId =
        normalized.dedupeKey ??
        headerValue(headers, "webhook-id") ??
        headerValue(headers, "x-github-delivery");
    if (webhookDeduper.isDuplicate(deliveryId)) {
        return { status: 200, body: { ok: true, duplicate: true, deliveryId } };
    }

    const subject =
        vendor === "render"
            ? (normalized.payload.serviceId as string | undefined)
            : (normalized.payload.repo as string | undefined);
    const attempt = failureStreaks.record(subject, normalized.failed);

    const signal = {
        id: `webhook-${vendor}-${deliveryId ?? Date.now()}`,
        source: normalized.source,
        type: normalized.type,
        createdAt: new Date().toISOString(),
        payload: { ...normalized.payload, attempt },
    };

    void handleOperatorSignal(signal).catch((error) => {
        hostLog.error("operator webhook processing failed", {
            vendor,
            signalId: signal.id,
            error: error instanceof Error ? error.message : String(error),
        });
    });

    return {
        status: 202,
        body: { ok: true, accepted: true, signalId: signal.id, type: signal.type, attempt },
    };
}

export async function resolveOperatorApproval(
    approvalId: string,
    decision: "approve" | "deny",
): Promise<{ ok: boolean; approval?: unknown; execution?: CapabilityExecution | null; error?: string }> {
    if (!booted) bootOperator();
    try {
        const approval = await approvals.resolve(approvalId, decision);
        if (!approval) {
            return { ok: false, error: `approval not found: ${approvalId}` };
        }
        if (decision === "deny") {
            await journal.append({
                ts: new Date().toISOString(),
                kind: "outcome",
                playbookId: approval.playbookId,
                signalId: approval.signalId,
                data: { approval, status: "denied" },
            });
            return { ok: true, approval, execution: null };
        }

        const result = await registry.execute(approval.capability, approval.args ?? {}, {
            signalId: approval.signalId,
            playbookId: approval.playbookId,
        });
        await journal.append({
            ts: new Date().toISOString(),
            kind: "outcome",
            playbookId: approval.playbookId,
            signalId: approval.signalId,
            data: { approval, status: result.ok ? "executed" : "failed", result },
        });
        return { ok: true, approval, execution: result };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

type CapabilityExecution = Awaited<ReturnType<CapabilityRegistry["execute"]>>;
