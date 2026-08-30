import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { WorkDir } from "../config/config.js";

const LOG_DIR = path.join(WorkDir, "logs");
const LOG_FILE = path.join(LOG_DIR, "brain.jsonl");
const MAX_LOG_BYTES = 10 * 1024 * 1024;

type Level = "info" | "warn" | "error" | "debug";

function safeTs(ts: string): string {
    return ts.replace(/[:.]/g, "-");
}

class BrainHostLogger {
    private stream: fs.WriteStream | null = null;
    private currentSize = 0;
    private ready: Promise<void> | null = null;
    private writeQueue: Promise<void> = Promise.resolve();

    private ensureReady(): Promise<void> {
        if (!this.ready) {
            this.ready = (async () => {
                await fsp.mkdir(LOG_DIR, { recursive: true });
                try {
                    const stats = await fsp.stat(LOG_FILE);
                    this.currentSize = stats.size;
                } catch {
                    this.currentSize = 0;
                }
                this.stream = fs.createWriteStream(LOG_FILE, { flags: "a", encoding: "utf8" });
            })();
        }
        return this.ready;
    }

    private async rotateIfNeeded(nextBytes: number): Promise<void> {
        if (this.currentSize + nextBytes <= MAX_LOG_BYTES) return;
        if (this.stream) {
            const stream = this.stream;
            this.stream = null;
            await new Promise<void>((resolve) => {
                stream.end(() => resolve());
            });
        }
        const rotated = path.join(LOG_DIR, `brain.${safeTs(new Date().toISOString())}.jsonl`);
        try {
            await fsp.rename(LOG_FILE, rotated);
        } catch {
            // ignore
        }
        this.currentSize = 0;
        this.stream = fs.createWriteStream(LOG_FILE, { flags: "a", encoding: "utf8" });
    }

    log(level: Level, message: string, fields?: Record<string, unknown>): void {
        const line =
            JSON.stringify({
                ts: new Date().toISOString(),
                level,
                message,
                ...fields,
            }) + "\n";
        const bytes = Buffer.byteLength(line, "utf8");
        this.writeQueue = this.writeQueue.then(async () => {
            await this.ensureReady();
            await this.rotateIfNeeded(bytes);
            this.stream?.write(line);
            this.currentSize += bytes;
        });
        const consoleLine = `[brain-host] ${message}`;
        if (level === "error") console.error(consoleLine, fields ?? "");
        else if (level === "warn") console.warn(consoleLine, fields ?? "");
        else console.log(consoleLine, fields ?? "");
    }

    info(message: string, fields?: Record<string, unknown>): void {
        this.log("info", message, fields);
    }

    warn(message: string, fields?: Record<string, unknown>): void {
        this.log("warn", message, fields);
    }

    error(message: string, fields?: Record<string, unknown>): void {
        this.log("error", message, fields);
    }
}

export const hostLog = new BrainHostLogger();
