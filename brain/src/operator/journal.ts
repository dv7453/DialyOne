import fs from "node:fs";
import path from "node:path";

import { JournalEntrySchema, type JournalEntry } from "./types.js";

export interface JournalWriter {
  append(entry: JournalEntry): void | Promise<void>;
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
}

export class InMemoryJournal implements JournalWriter {
  private readonly entries: JournalEntry[] = [];

  append(entry: JournalEntry): void {
    this.entries.push(JournalEntrySchema.parse(entry));
  }

  readAll(): JournalEntry[] {
    return [...this.entries];
  }
}
