import fs from "node:fs";
import path from "node:path";

import { JournalEntrySchema, type JournalEntry } from "./types.js";

export const JOURNAL_LIST_DEFAULT_LIMIT = 40;
export const JOURNAL_LIST_MAX_LIMIT = 200;

export interface JournalWriter {
  append(entry: JournalEntry): void | Promise<void>;
  list(limit: number): Promise<JournalEntry[]>;
}

/**
 * HTTP `?limit=` parser: default 40, max 200, non-numeric falls back to default.
 * Negative values clamp to 0 so a caller cannot ask the store for "all rows".
 */
export function clampJournalListLimit(limit: unknown): number {
  if (typeof limit === "number") {
    if (!Number.isFinite(limit)) {
      return JOURNAL_LIST_DEFAULT_LIMIT;
    }
    return Math.min(JOURNAL_LIST_MAX_LIMIT, Math.max(0, Math.trunc(limit)));
  }
  if (typeof limit === "string") {
    const trimmed = limit.trim();
    if (trimmed === "") {
      return JOURNAL_LIST_DEFAULT_LIMIT;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      return JOURNAL_LIST_DEFAULT_LIMIT;
    }
    return Math.min(JOURNAL_LIST_MAX_LIMIT, Math.max(0, Math.trunc(n)));
  }
  return JOURNAL_LIST_DEFAULT_LIMIT;
}

export class Journal implements JournalWriter {
  constructor(private readonly filePath: string) {}

  append(entry: JournalEntry): void {
    JournalEntrySchema.parse(entry);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }

  readAll(): JournalEntry[] {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const raw = fs.readFileSync(this.filePath, "utf8").trim();
    if (!raw) {
      return [];
    }

    return raw.split("\n").map((line) => JournalEntrySchema.parse(JSON.parse(line)));
  }

  /**
   * Newest first. Reads a growing tail window rather than the whole JSONL file,
   * so a 40-line Access page cannot slurp a multi-gigabyte log.
   *
   * Tradeoff: if almost every line is unparseable we double the window until we
   * hit byte 0, which is then a full read. Healthy logs are dense valid JSONL,
   * so the first 64KiB-or-so window is enough for typical limits.
   */
  async list(limit: number): Promise<JournalEntry[]> {
    return readJsonlTail(this.filePath, limit);
  }
}

export class InMemoryJournal implements JournalWriter {
  private readonly entries: JournalEntry[] = [];

  append(entry: JournalEntry): void {
    this.entries.push(JournalEntrySchema.parse(entry));
  }

  readAll(): JournalEntry[] {
    return [...this.entries];
  }

  async list(limit: number): Promise<JournalEntry[]> {
    const n = normalizeListLimit(limit);
    const out: JournalEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < n; i -= 1) {
      out.push(this.entries[i]!);
    }
    return out;
  }
}

const TAIL_MIN_BYTES = 64 * 1024;
const TAIL_BYTES_PER_ENTRY = 4 * 1024;

function normalizeListLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 0;
  }
  return Math.max(0, Math.trunc(limit));
}

function parseJournalLine(line: string): JournalEntry | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JournalEntrySchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function collectNewest(lines: string[], limit: number): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const entry = parseJournalLine(lines[i] ?? "");
    if (entry) {
      out.push(entry);
    }
  }
  return out;
}

function readJsonlTail(filePath: string, limit: number): JournalEntry[] {
  const n = normalizeListLimit(limit);
  if (n === 0) {
    return [];
  }
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) {
      return [];
    }

    let window = Math.min(size, Math.max(TAIL_MIN_BYTES, n * TAIL_BYTES_PER_ENTRY));
    let entries: JournalEntry[] = [];

    while (true) {
      const start = size - window;
      const buf = Buffer.allocUnsafe(window);
      const bytesRead = fs.readSync(fd, buf, 0, window, start);
      const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
      // A window that does not start at byte 0 begins mid-line; drop that stub.
      if (start > 0 && lines.length > 0) {
        lines.shift();
      }
      entries = collectNewest(lines, n);
      if (entries.length >= n || start === 0) {
        return entries;
      }
      const next = Math.min(size, window * 2);
      if (next === window) {
        return entries;
      }
      window = next;
    }
  } finally {
    fs.closeSync(fd);
  }
}
