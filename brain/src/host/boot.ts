/**
 * Headless Dialy host boot — the subset of Electron main.ts that must keep
 * running when the UI is quit. Model stays idle until a channel/event wakes it
 * (Spike B+). Failures in individual services must not kill the process.
 */
import container from "../di/container.js";
import type { ISessions } from "../runtime/sessions/api.js";
import { initConfigs } from "../config/initConfigs.js";
import { migrateRuns } from "../migrations/runs/migrate.js";
import { init as initChannels } from "../channels/service.js";
import { init as initLiveNoteScheduler } from "../knowledge/live-note/scheduler.js";
import { init as initBackgroundTaskScheduler } from "../background-tasks/scheduler.js";
import { init as initEventProcessor, registerConsumer } from "../events/init.js";
import { liveNoteEventConsumer } from "../knowledge/live-note/event-consumer.js";
import { backgroundTaskEventConsumer } from "../background-tasks/event-consumer.js";
import { startSkillsWatcher } from "../runtime/assembly/skills/watcher.js";
import { init as initGmailSync } from "../knowledge/sync_gmail.js";
import { init as initOutlookSync } from "../knowledge/sync_outlook.js";
import { init as initCalendarSync } from "../knowledge/sync_calendar.js";
import { init as initOutlookCalendarSync } from "../knowledge/sync_outlook_calendar.js";
import { init as initFirefliesSync } from "../knowledge/sync_fireflies.js";
import { init as initGranolaSync } from "../knowledge/granola/sync.js";
import { init as initGraphBuilder } from "../knowledge/build_graph.js";
import { init as initNoteTagging } from "../knowledge/tag_notes.js";
import { init as initInlineTasks } from "../knowledge/inline_tasks.js";
import { init as initAgentRunner } from "../agent-schedule/runner.js";
import { init as initAgentNotes } from "../knowledge/agent_notes.js";
import { init as initCalendarNotifications } from "../knowledge/notify_calendar_meetings.js";
import { init as initMeetingPrep } from "../knowledge/meeting_prep_scheduler.js";
import { startModelsDevRefresh } from "../models/models-dev.js";
import { registerNoopPlatformServices } from "./noop-platform.js";
import { hostLog } from "./logger.js";
import { hostState } from "./state.js";
import { startChannelsConfigWatcher } from "./channels-watch.js";
import { bootOperator } from "./operator-boot.js";

function startService(name: string, start: () => void | Promise<void>): void {
    try {
        const result = start();
        if (result && typeof (result as Promise<void>).then === "function") {
            void (result as Promise<void>).catch((error) => {
                hostLog.error(`service ${name} failed`, {
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }
        hostState.services.push(name);
        hostLog.info(`service started: ${name}`);
    } catch (error) {
        hostLog.error(`service ${name} threw on start`, {
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

export async function bootDialyHost(): Promise<void> {
    hostLog.info("boot begin");
    registerNoopPlatformServices();

    await initConfigs();
    startModelsDevRefresh();

    try {
        const migration = migrateRuns();
        if (migration.scanned > 0) {
            hostLog.info("runs migration", {
                scanned: migration.scanned,
                migratedSessions: migration.migratedSessions,
                migratedTurns: migration.migratedTurns,
            });
        }
    } catch (error) {
        hostLog.warn("runs migration failed", {
            error: error instanceof Error ? error.message : String(error),
        });
    }

    try {
        await container.resolve<ISessions>("sessions").initialize();
        hostState.services.push("sessions");
        hostLog.info("sessions initialized");
    } catch (error) {
        hostState.bootOk = false;
        hostState.bootError = error instanceof Error ? error.message : String(error);
        hostLog.error("sessions.initialize failed", { error: hostState.bootError });
        throw error;
    }

    startService("channels", () => initChannels());
    startService("channels-config-watcher", () => startChannelsConfigWatcher());
    try {
        bootOperator();
        hostState.services.push("operator");
        hostLog.info("service started: operator");
    } catch (error) {
        hostState.bootOk = false;
        hostState.bootError = error instanceof Error ? error.message : String(error);
        hostLog.error("service operator threw on start", { error: hostState.bootError });
        throw error;
    }
    startService("live-note-scheduler", () => initLiveNoteScheduler());
    startService("bg-task-scheduler", () => initBackgroundTaskScheduler());
    startService("skills-watcher", () => startSkillsWatcher());

    registerConsumer(liveNoteEventConsumer);
    registerConsumer(backgroundTaskEventConsumer);
    // Never-resolving poll loop — same fire-and-forget as Electron main.
    startService("event-processor", () => {
        void initEventProcessor();
    });

    startService("gmail-sync", () => initGmailSync());
    startService("outlook-sync", () => initOutlookSync());
    startService("calendar-sync", () => initCalendarSync());
    startService("outlook-calendar-sync", () => initOutlookCalendarSync());
    startService("fireflies-sync", () => initFirefliesSync());
    startService("granola-sync", () => initGranolaSync());
    startService("graph-builder", () => initGraphBuilder());
    startService("note-tagging", () => initNoteTagging());
    startService("inline-tasks", () => initInlineTasks());
    startService("agent-runner", () => initAgentRunner());
    startService("agent-notes", () => initAgentNotes());
    startService("calendar-notifications", () => initCalendarNotifications());
    startService("meeting-prep", () => {
        void initMeetingPrep();
    });

    hostState.bootOk = true;
    hostState.modelIdle = true;
    hostLog.info("boot complete — model idle", { services: hostState.services.length });
}
