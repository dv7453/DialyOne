import { checkOnce, sendAlert } from "./check.js";

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_FAILURE_THRESHOLD = 3;

function envNumber(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const intervalMs = envNumber("WATCHDOG_INTERVAL_MS", DEFAULT_INTERVAL_MS);
const failureThreshold = envNumber("WATCHDOG_FAILURE_THRESHOLD", DEFAULT_FAILURE_THRESHOLD);
const healthUrl = process.env.HEALTH_URL ?? "http://127.0.0.1:8787/health";

let consecutiveFailures = 0;
let running = false;

async function tick(): Promise<void> {
    if (running) {
        return;
    }

    running = true;
    try {
        const result = await checkOnce(healthUrl);
        if (result.ok) {
            if (consecutiveFailures > 0) {
                console.error(`[dialy-watchdog] recovered after ${consecutiveFailures} failure(s)`);
            }
            consecutiveFailures = 0;
            console.log(`[dialy-watchdog] ok ${result.checkedAt} ${result.healthUrl}`);
            return;
        }

        consecutiveFailures += 1;
        console.error(`[dialy-watchdog] failure ${consecutiveFailures}/${failureThreshold}: ${result.message}`);

        if (consecutiveFailures >= failureThreshold && consecutiveFailures % failureThreshold === 0) {
            await sendAlert([
                "Dialy watchdog alert",
                `Health URL: ${result.healthUrl}`,
                `Failures: ${consecutiveFailures}`,
                `Checked at: ${result.checkedAt}`,
                `Reason: ${result.message}`,
            ].join("\n"));
        }
    } catch (error) {
        consecutiveFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[dialy-watchdog] internal failure ${consecutiveFailures}/${failureThreshold}: ${message}`);
        if (consecutiveFailures >= failureThreshold && consecutiveFailures % failureThreshold === 0) {
            await sendAlert(`Dialy watchdog internal failure after ${consecutiveFailures} attempts: ${message}`);
        }
    } finally {
        running = false;
    }
}

console.log(`[dialy-watchdog] monitoring ${healthUrl} every ${intervalMs}ms`);
void tick();
setInterval(() => void tick(), intervalMs);
