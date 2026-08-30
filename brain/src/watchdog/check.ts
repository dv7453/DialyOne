import fs from "node:fs";
import path from "node:path";

export type WatchdogCheck = {
    ok: boolean;
    checkedAt: string;
    healthUrl: string;
    status: number | null;
    message: string;
    render?: {
        checked: boolean;
        ok: boolean;
        status: number | null;
        message: string;
    };
};

type RenderService = {
    service?: {
        suspended?: string;
        name?: string;
    };
};

const DEFAULT_TIMEOUT_MS = 10_000;

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), envNumber("WATCHDOG_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

async function checkRenderService(): Promise<WatchdogCheck["render"]> {
    const apiKey = process.env.RENDER_API_KEY;
    const serviceId = process.env.RENDER_SERVICE_ID;
    if (!apiKey || !serviceId) {
        return undefined;
    }

    try {
        const response = await fetchWithTimeout(`https://api.render.com/v1/services/${serviceId}`, {
            headers: {
                accept: "application/json",
                authorization: `Bearer ${apiKey}`,
            },
        });
        const body = await response.json().catch(() => ({})) as RenderService;
        const suspended = body.service?.suspended;
        const ok = response.ok && (!suspended || suspended === "not_suspended");
        return {
            checked: true,
            ok,
            status: response.status,
            message: ok
                ? `Render service ${body.service?.name ?? serviceId} is not suspended.`
                : `Render service ${serviceId} status check failed or is suspended: ${suspended ?? "unknown"}.`,
        };
    } catch (error) {
        return {
            checked: true,
            ok: false,
            status: null,
            message: `Render service check failed: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

export async function checkOnce(healthUrl = process.env.HEALTH_URL ?? "http://127.0.0.1:8787/health"): Promise<WatchdogCheck> {
    const checkedAt = new Date().toISOString();
    let healthOk = false;
    let status: number | null = null;
    let message = "";

    try {
        const response = await fetchWithTimeout(healthUrl, { headers: { accept: "application/json" } });
        status = response.status;
        healthOk = response.ok;
        message = response.ok ? "Health check passed." : `Health check returned HTTP ${response.status}.`;
    } catch (error) {
        message = `Health check failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    const render = await checkRenderService();
    const ok = healthOk && (render ? render.ok : true);

    return {
        ok,
        checkedAt,
        healthUrl,
        status,
        message: ok ? message : [message, render && !render.ok ? render.message : ""].filter(Boolean).join(" "),
        render,
    };
}

export async function sendAlert(message: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_NOTIFY_CHAT_ID;
    if (token && chatId) {
        const response = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: message }),
        });
        if (!response.ok) {
            throw new Error(`Telegram alert failed with HTTP ${response.status}`);
        }
        return;
    }

    const alertFile = process.env.WATCHDOG_ALERT_FILE;
    if (alertFile) {
        fs.mkdirSync(path.dirname(alertFile), { recursive: true });
        fs.appendFileSync(alertFile, `${message}\n`, "utf8");
        return;
    }

    console.error(`[dialy-watchdog-alert] ${message}`);
}
