/**
 * Headless brain entry: OS awake, model asleep, Electron optional.
 *
 *   cd brain && npm run build && BRAIN_HOST=0.0.0.0 npm run start
 *
 * Quit Electron; phone on same Wi‑Fi hits http://<lan-ip>:8787/health
 */
import { bootDialyHost } from "./boot.js";
import { createHostHttpServer, listenHostHttp } from "./http.js";
import { hostLog } from "./logger.js";
import { hostState } from "./state.js";

async function main(): Promise<void> {
    hostState.startedAt = Date.now();
    const server = createHostHttpServer();

    // Listen early so /health can answer during long boot (503 until bootOk).
    await listenHostHttp(server);

    try {
        await bootDialyHost();
    } catch (error) {
        hostState.bootOk = false;
        hostState.bootError = error instanceof Error ? error.message : String(error);
        hostLog.error("fatal boot failure — HTTP stays up for diagnosis", {
            error: hostState.bootError,
        });
    }

    const shutdown = (signal: string) => {
        hostLog.info(`shutdown ${signal}`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error) => {
    console.error("[brain-host] crashed", error);
    process.exit(1);
});
