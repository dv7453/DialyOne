import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WorkDir } from "../config/config.js";
import { InMemoryApprovalsStore, type ApprovalsStore } from "../operator/approvals.js";
import { CalendarAdapter } from "../operator/capabilities/adapters/calendar.js";
import { GitHubCodeAdapter } from "../operator/capabilities/adapters/code-github.js";
import { RenderDeployAdapter } from "../operator/capabilities/adapters/deploy-render.js";
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
import { SignalSchema, type ActionRequest, type Signal } from "../operator/types.js";
import { hostLog } from "./logger.js";

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
const approvals: ApprovalsStore = new InMemoryApprovalsStore();
const registry = new CapabilityRegistry();

let nextActionId = 1;
let booted = false;

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
        .register(new NotifyAdapter([new ConsoleNotifySink(), new TelegramNotifySink()]));
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

export async function handleOperatorSignal(input: unknown): Promise<PublicEngineResult> {
    if (!booted) bootOperator();
    const signal = normalizeSignal(input);
    const result = await processSignal(signal, listPlaybooks(), {
        journal,
        capabilities: registry,
        createActionId: () => `operator-action-${nextActionId++}`,
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
