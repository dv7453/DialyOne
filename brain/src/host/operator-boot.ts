import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { reduceTurn } from "@x/shared/dist/turns.js";
import { ingestAgentMailWebhook } from "../agentmail/webhook.js";
import { getCurrentUserId } from "../auth/context.js";
import container from "../di/container.js";
import { WorkDir } from "../config/config.js";
import { runWithBudgetUser } from "../llm/index.js";
import type { ActionQueue } from "../operator/action-queue.js";
import type { ApprovalExpiryStore } from "../operator/approvals.js";
import { startApprovalReaper } from "../operator/approval-reaper.js";
import { shutdownLangfuse } from "../observability/index.js";
import { CalendarAdapter } from "../operator/capabilities/adapters/calendar.js";
import { GitHubCodeAdapter } from "../operator/capabilities/adapters/code-github.js";
import { RenderDeployAdapter } from "../operator/capabilities/adapters/deploy-render.js";
import { JournalLogAdapter } from "../operator/capabilities/adapters/journal-log.js";
import { MailAdapter } from "../operator/capabilities/adapters/mail-agentmail.js";
import { ConsoleNotifySink, NotifyAdapter, TelegramNotifySink } from "../operator/capabilities/adapters/notify.js";
import { CapabilityRegistry } from "../operator/capabilities/registry.js";
import { processSignal } from "../operator/engine.js";
import { executeEngineResult, type ExecutionSummary } from "../operator/executor.js";
import { clampJournalListLimit, type JournalWriter } from "../operator/journal.js";
import { InMemoryTrustLedger, type TrustLedger } from "../operator/trust.js";
import { getDb } from "../db/client.js";
import { createPgTrustLedger } from "../db/trust-store.js";
import {
    attachTurnPermissionBridge,
    inspectTurnToolOutcome,
    resolveApprovalDecision,
} from "../operator/turn-approvals.js";
import {
    getPlaybookLoadErrors,
    listPlaybooks,
    loadPlaybooksFromDir,
} from "../operator/playbooks/loader.js";
import type { ISessions } from "../runtime/sessions/api.js";
import type { ITurnEventBus } from "../runtime/turns/event-hub.js";
import { OperatorScheduler } from "../operator/scheduler.js";
import type { SchedulerStateStore, TickLock } from "../operator/scheduler-state.js";
import { SignalSchema, type ActionRequest, type Signal } from "../operator/types.js";
import { hostLog } from "./logger.js";
import {
    ActionQueueDrainWorker,
    isDrainDisabled,
    readDrainBatchSize,
    readDrainIntervalMs,
} from "./operator-drain.js";
import { createOperatorStores, type OperatorStoreBackend } from "./operator-stores.js";
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
// Streaks are the product's trust ramp: an in-memory ledger silently resets a
// user's earned autonomy on every deploy, so Postgres is used whenever present.
const trust: TrustLedger = process.env.DATABASE_URL
    ? createPgTrustLedger(getDb(), { userId: process.env.DIALY_DEFAULT_USER_ID })
    : new InMemoryTrustLedger();
const registry = new CapabilityRegistry();
const telegramNotify = new TelegramNotifySink();

const failureStreaks = new FailureStreaks();
const webhookDeduper = new WebhookDeduper();

let journal: JournalWriter;
let approvals: ApprovalExpiryStore;
let stopReaper: (() => void) | undefined;
let actionQueue: ActionQueue;
let schedulerState: SchedulerStateStore;
let tickLock: TickLock;
let storeBackend: OperatorStoreBackend = "local";
let boundTenantUserId: string | undefined;

// Action ids are namespaced per boot so persisted approvals from an earlier
// process can never collide with ids minted after a restart.
const bootId = randomUUID().slice(0, 8);
let nextActionId = 1;
let booted = false;
let scheduler: OperatorScheduler | undefined;
let drainWorker: ActionQueueDrainWorker | undefined;

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
    if (registry.listAdapters().length > 0) {
        return;
    }
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

function hostSessions(): ISessions {
    return container.resolve<ISessions>("sessions");
}

export function bootOperator(): void {
    if (booted) return;
    const stores = createOperatorStores();
    journal = stores.journal;
    approvals = stores.approvals;
    actionQueue = stores.queue;
    schedulerState = stores.schedulerState;
    tickLock = stores.tickLock;
    storeBackend = stores.backend;
    boundTenantUserId = stores.userId;
    hostLog.info("operator stores selected", {
        backend: stores.backend,
        tenantUserId: stores.userId ?? null,
    });
    seedPlaybooks();
    registerCapabilities();
    assertAdapterFlagCapabilities(registry);
    attachTurnPermissionBridge({
        bus: container.resolve<ITurnEventBus>("turnEventBus"),
        approvals,
        journal,
        getToolCall: async (turnId, toolCallId) => {
            const turn = await hostSessions().getTurn(turnId);
            const tc = reduceTurn(turn.events).toolCalls.find((call) => call.toolCallId === toolCallId);
            return tc ? { toolName: tc.toolName, input: tc.input } : undefined;
        },
        onError: (message, meta) => hostLog.warn(message, meta),
    });
    const sourceDir = hasPlaybookFiles(workPlaybooksDir) ? workPlaybooksDir : packagedPlaybooksDir;
    const playbooks = loadPlaybooksFromDir(sourceDir);
    hostLog.info("operator playbooks loaded", {
        sourceDir,
        count: playbooks.length,
        errors: getPlaybookLoadErrors().length,
    });
    booted = true;
    startScheduler();
    startDrainWorker();
    startReaper();
}

/**
 * Without this, an approval nobody answers holds its turn suspended forever and
 * the card stays on screen. Expiry is a denial: the turn resumes, the journal
 * records the timeout, and the trust streak resets rather than being credited.
 *
 * The interval runs outside any request, so ALS is empty here — the tenant comes
 * from the bound store or DIALY_DEFAULT_USER_ID, never getCurrentUserId().
 */
function startReaper(): void {
    if (stopReaper || process.env.DIALY_APPROVAL_REAPER === "off") return;
    stopReaper = startApprovalReaper({
        approvals,
        journal,
        resumeTurn: (turnId, toolCallId, decision) =>
            hostSessions().respondToPermission(turnId, toolCallId, decision, { reason: "expired" }),
        trust,
        userId: boundTenantUserId ?? process.env.DIALY_DEFAULT_USER_ID,
    });
    hostLog.info("approval reaper started");
}

export async function shutdownOperator(): Promise<void> {
    stopOperatorScheduler();
    await shutdownLangfuse();
}

/**
 * Trust and the executor both no-op when userId is missing. Callers must go
 * through this so a missing tenant cannot silently drop the ramp.
 */
export function requireOperatorUserId(explicit?: string): string {
    const userId = explicit ?? getCurrentUserId() ?? process.env.DIALY_DEFAULT_USER_ID;
    if (!userId) {
        throw new Error(
            "operator trust ledger requires a userId (authenticated session or DIALY_DEFAULT_USER_ID); refusing to execute so the trust ramp cannot be silently skipped",
        );
    }
    return userId;
}

/**
 * Postgres stores are constructor-bound to DIALY_DEFAULT_USER_ID. Using a
 * different session userId would throw inside PgActionQueue.enqueue. Local
 * file/memory stores are not tenant-scoped, so the request user is fine.
 */
function operatorExecuteUserId(explicit?: string): string {
    if (storeBackend === "postgres") {
        if (!boundTenantUserId) {
            throw new Error(
                "Postgres operator stores require DIALY_DEFAULT_USER_ID; refusing to execute without a bound tenant",
            );
        }
        return boundTenantUserId;
    }
    return requireOperatorUserId(explicit);
}

function schedulerBudgetUserId(): string | undefined {
    return process.env.DIALY_BUDGET_USER_ID ?? process.env.DIALY_DEFAULT_USER_ID;
}

function withSchedulerBudget<T>(fn: () => T): T {
    const userId = schedulerBudgetUserId();
    if (!userId) {
        return fn();
    }
    return runWithBudgetUser(userId, fn);
}

function startScheduler(): void {
    if (scheduler || process.env.OPERATOR_SCHEDULER === "off") return;
    if (!schedulerBudgetUserId()) {
        hostLog.warn(
            "operator scheduler has no DIALY_BUDGET_USER_ID or DIALY_DEFAULT_USER_ID; background LLM spend falls back to the shared default budget user",
        );
    }
    const tenantUserId = boundTenantUserId ?? process.env.DIALY_DEFAULT_USER_ID;
    scheduler = new OperatorScheduler({
        listPlaybooks: () => listPlaybooks(),
        emit: (signal) => handleOperatorSignal(signal, tenantUserId ? { userId: tenantUserId } : undefined),
        runProbe: (capability, args) => withSchedulerBudget(() => registry.execute(capability, args, {})),
        onError: (message, meta) => hostLog.warn(message, meta),
        state: schedulerState,
        lock: tickLock,
    });
    scheduler.start();
    hostLog.info("operator scheduler started");
}

function startDrainWorker(): void {
    if (drainWorker || isDrainDisabled()) return;
    drainWorker = new ActionQueueDrainWorker({
        backend: storeBackend,
        queue: actionQueue,
        journal,
        registry,
        trust,
        intervalMs: readDrainIntervalMs(),
        batchSize: readDrainBatchSize(),
        onError: (message, meta) => hostLog.warn(message, meta),
    });
    drainWorker.start();
    hostLog.info("operator drain worker started", {
        backend: storeBackend,
        intervalMs: readDrainIntervalMs(),
        batchSize: readDrainBatchSize(),
    });
}

export function stopOperatorScheduler(): void {
    scheduler?.stop();
    scheduler = undefined;
    drainWorker?.stop();
    drainWorker = undefined;
    stopReaper?.();
    stopReaper = undefined;
}

export function getOperatorPlaybooks(): Array<{ id: string; title: string; enabled: boolean }> {
    return listPlaybooks().map((playbook) => ({
        id: playbook.id,
        title: playbook.title,
        enabled: playbook.enabled,
    }));
}

export async function getOperatorApprovals() {
    if (!booted) bootOperator();
    return approvals.listPending();
}

export async function getOperatorJournal(limit: unknown) {
    if (!booted) bootOperator();
    return journal.list(clampJournalListLimit(limit));
}

export async function getOperatorTrust() {
    if (!booted) bootOperator();
    return trust.list();
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

/** Flags are keyed by capability, not adapter id, so a rename cannot report "disconnected". */
export const ADAPTER_FLAG_CAPABILITIES: Record<Exclude<keyof OperatorAdapterFlags, "telegram">, string> = {
    render: "deploy.health",
    github: "code.draft_pr",
    mail: "mail.send",
    calendar: "calendar.create",
    notify: "notify.escalate",
};

export function assertAdapterFlagCapabilities(target: CapabilityRegistry): void {
    for (const [flag, capability] of Object.entries(ADAPTER_FLAG_CAPABILITIES)) {
        if (!target.has(capability)) {
            throw new Error(
                `operator boot: adapter flag "${flag}" requires capability "${capability}" but none is registered — refusing to report it as disconnected`,
            );
        }
    }
}

export function adapterFlagsFromStatuses(
    adapters: OperatorCapabilityStatus[],
    telegramAvailable: boolean,
): OperatorAdapterFlags {
    const flags: OperatorAdapterFlags = {
        render: false,
        github: false,
        mail: false,
        calendar: false,
        notify: false,
        telegram: telegramAvailable,
    };
    for (const [flag, capability] of Object.entries(ADAPTER_FLAG_CAPABILITIES)) {
        const adapter = adapters.find((entry) => entry.capabilities.includes(capability));
        if (!adapter) {
            throw new Error(
                `operator adapter flag "${flag}" has no registered adapter offering "${capability}"`,
            );
        }
        flags[flag as keyof typeof ADAPTER_FLAG_CAPABILITIES] = adapter.available;
    }
    return flags;
}

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
    const flags = adapterFlagsFromStatuses(adapters, await telegramNotify.isAvailable());
    return { adapters, flags };
}

export async function handleOperatorSignal(
    input: unknown,
    opts?: { userId?: string },
): Promise<PublicEngineResult> {
    if (!booted) bootOperator();
    const userId = operatorExecuteUserId(opts?.userId);
    return runWithBudgetUser(userId, () => runOperatorSignal(input, userId));
}

async function runOperatorSignal(input: unknown, userId: string): Promise<PublicEngineResult> {
    if (!booted) bootOperator();
    const signal = normalizeSignal(input);
    const result = await processSignal(signal, listPlaybooks(), {
        journal,
        capabilities: registry,
        createActionId: () => `operator-action-${bootId}-${nextActionId++}`,
    });

    const execution = await executeEngineResult(result, registry, approvals, journal, {
        queue: actionQueue,
        trust,
        userId,
    });

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

    const tenantUserId = boundTenantUserId ?? process.env.DIALY_DEFAULT_USER_ID;
    void handleOperatorSignal(signal, tenantUserId ? { userId: tenantUserId } : undefined).catch((error) => {
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

export async function ingestOperatorAgentMailWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
): Promise<WebhookIngestResult> {
    if (!booted) bootOperator();
    const tenantUserId = boundTenantUserId ?? process.env.DIALY_DEFAULT_USER_ID;
    return ingestAgentMailWebhook(headers, rawBody, {
        onSignal: async (signal) => {
            try {
                await handleOperatorSignal(signal, tenantUserId ? { userId: tenantUserId } : undefined);
            } catch (error) {
                hostLog.error("operator webhook processing failed", {
                    vendor: "agentmail",
                    signalId: signal.id,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        },
        deduper: webhookDeduper,
        failureStreaks,
    });
}

export async function resolveOperatorApproval(
    approvalId: string,
    decision: "approve" | "deny",
): Promise<{ ok: boolean; approval?: unknown; execution?: CapabilityExecution | null; error?: string }> {
    if (!booted) bootOperator();
    return resolveApprovalDecision(approvalId, decision, {
        approvals,
        journal,
        executeCapability: (capability, args, ctx) => registry.execute(capability, args, ctx),
        resumeTurn: (turnId, toolCallId, permission) =>
            hostSessions().respondToPermission(turnId, toolCallId, permission, { approvalId }),
        inspectTurnToolOutcome: (turnId, toolCallId) => inspectTurnToolOutcome(hostSessions(), turnId, toolCallId),
        trust,
        userId: operatorExecuteUserId(),
    });
}

type CapabilityExecution = Awaited<ReturnType<CapabilityRegistry["execute"]>>;
