import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { WorkDir } from "../config/config.js";
import container from "../di/container.js";
import type { IChannelsConfigRepo } from "../channels/repo.js";
import { applyChannelsConfig } from "../channels/service.js";
import { hostLog } from "./logger.js";

const CHANNELS_CONFIG = path.join(WorkDir, "config", "channels.json");
const DEBOUNCE_MS = 400;

let watcher: FSWatcher | null = null;
let timer: NodeJS.Timeout | null = null;

async function reload(): Promise<void> {
    try {
        const config = await container
            .resolve<IChannelsConfigRepo>("channelsConfigRepo")
            .getConfig();
        await applyChannelsConfig(config);
        hostLog.info("channels config reloaded", {
            telegram: config.telegram.enabled,
            whatsapp: config.whatsapp.enabled,
        });
    } catch (error) {
        hostLog.error("channels config reload failed", {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/** Live-reload Telegram/WhatsApp when ~/.rowboat/config/channels.json changes. */
export function startChannelsConfigWatcher(): void {
    if (watcher) return;
    watcher = chokidar.watch(CHANNELS_CONFIG, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            void reload();
        }, DEBOUNCE_MS);
    };
    watcher.on("change", schedule).on("add", schedule);
    hostLog.info("watching channels.json for changes");
}
