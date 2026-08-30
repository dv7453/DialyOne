/**
 * Electron registers real platform services on the DI container. Headless
 * boot needs the same keys present so calendar notifications / tools don't
 * throw if something resolves them while idle.
 */
import type { IBrowserControlService } from "../application/browser-control/service.js";
import type { INotificationService } from "../application/notification/service.js";
import type { IScreenPointerService } from "../application/screen-pointer/service.js";
import type { ITextInsertService } from "../application/text-insert/service.js";
import {
    registerBrowserControlService,
    registerNotificationService,
    registerScreenPointerService,
    registerTextInsertService,
} from "../di/container.js";

const noopNotification: INotificationService = {
    isSupported: () => false,
    notify: () => undefined,
};

const noopBrowser: IBrowserControlService = {
    execute: async (input) => ({
        success: false,
        action: input.action,
        error: "browser control unavailable in headless host",
        browser: { activeTabId: null, tabs: [] },
    }),
};

const noopScreenPointer: IScreenPointerService = {
    isShareActive: () => false,
    point: async () => ({ success: false, error: "screen pointer unavailable in headless host" }),
    hide: async () => undefined,
};

const noopTextInsert: ITextInsertService = {
    isSupported: () => false,
    captureTarget: async () => undefined,
    insert: async () => ({ ok: false, error: "text insert unavailable in headless host" }),
};

export function registerNoopPlatformServices(): void {
    registerNotificationService(noopNotification);
    registerBrowserControlService(noopBrowser);
    registerScreenPointerService(noopScreenPointer);
    registerTextInsertService(noopTextInsert);
}
