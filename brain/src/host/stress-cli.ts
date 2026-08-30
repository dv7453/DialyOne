/**
 * Light stress for Dialy host path (G4).
 *
 * Boots sessions + ChannelBridge only (no HTTP / no sync loops), then:
 *  - STRESS_HELP (default 20) no-LLM "help" turns (lock / reply path)
 *  - STRESS_PINGS (default 3) short model turns (wake → idle)
 *
 * Stop the headless host / launchd agent first so WorkDir isn't dual-owned:
 *   bash brain/deploy/install-launchd.sh   # after stress, to restore
 *   # or: launchctl bootout gui/$(id -u)/com.dialy.brain
 *
 *   cd brain && npm run stress
 */
import container from "../di/container.js";
import type { ISessions } from "../runtime/sessions/api.js";
import type { ITurnEventBus } from "../runtime/turns/event-hub.js";
import { initConfigs } from "../config/initConfigs.js";
import { ChannelBridge } from "../channels/bridge.js";
import { getModelCatalog, providerDisplayName } from "../models/catalog.js";
import { registerNoopPlatformServices } from "./noop-platform.js";
import { hostState } from "./state.js";

const HELP_N = Number(process.env.STRESS_HELP ?? 20);
const PING_N = Number(process.env.STRESS_PINGS ?? 3);
const SENDER = "telegram:stress";

async function listModels() {
    const catalog = await getModelCatalog();
    return catalog.providers
        .filter((p) => p.status === "ok")
        .flatMap((p) =>
            p.models.map((m) => ({
                provider: p.id,
                model: m.id,
                label: `${m.name ?? m.id} — ${providerDisplayName(p.flavor)}`,
            })),
        );
}

async function main(): Promise<void> {
    registerNoopPlatformServices();
    await initConfigs();
    await container.resolve<ISessions>("sessions").initialize();

    const bridge = new ChannelBridge({
        sessions: container.resolve<ISessions>("sessions"),
        turnEventBus: container.resolve<ITurnEventBus>("turnEventBus"),
        listModels,
    });

    const replies: string[] = [];
    const reply = async (text: string) => {
        replies.push(text);
    };

    console.log(`[stress] help x${HELP_N} (no LLM)…`);
    const helpStart = Date.now();
    for (let i = 0; i < HELP_N; i++) {
        replies.length = 0;
        await bridge.handleInbound(SENDER, "help", reply);
        if (!replies.some((r) => /commands/i.test(r))) {
            throw new Error(`help #${i + 1} missing commands reply`);
        }
    }
    console.log(`[stress] help ok in ${Date.now() - helpStart}ms`);

    console.log(`[stress] model pings x${PING_N}…`);
    const pingStart = Date.now();
    for (let i = 0; i < PING_N; i++) {
        replies.length = 0;
        await bridge.handleInbound(
            SENDER,
            `Reply with exactly one word: pong${i + 1}`,
            reply,
        );
        const body = replies.join("\n");
        if (!body.trim()) throw new Error(`ping #${i + 1} empty reply`);
        console.log(`[stress] ping #${i + 1} ok (${body.slice(0, 80).replace(/\n/g, " ")}…)`);
        if (!hostState.modelIdle) {
            throw new Error(`ping #${i + 1} left model_idle=false`);
        }
    }
    console.log(`[stress] pings ok in ${Date.now() - pingStart}ms`);
    console.log(
        JSON.stringify(
            {
                ok: true,
                help: HELP_N,
                pings: PING_N,
                lastTurnId: hostState.lastTurnId,
                model_idle: hostState.modelIdle,
            },
            null,
            2,
        ),
    );
    process.exit(0);
}

main().catch((err) => {
    console.error("[stress] failed", err);
    process.exit(1);
});
