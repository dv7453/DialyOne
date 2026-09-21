import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clampJournalListLimit,
  InMemoryJournal,
  Journal,
  JOURNAL_LIST_DEFAULT_LIMIT,
  JOURNAL_LIST_MAX_LIMIT,
} from "./journal.js";
import type { JournalEntry } from "./types.js";

const entry = (n: number, ts = `2026-08-30T10:00:${String(n).padStart(2, "0")}.000Z`): JournalEntry => ({
  ts,
  kind: "outcome",
  playbookId: "inbox",
  signalId: `sig-${n}`,
  data: { n },
});

describe("clampJournalListLimit", () => {
  it("defaults non-numeric input and clamps to the HTTP max", () => {
    expect(clampJournalListLimit(undefined)).toBe(JOURNAL_LIST_DEFAULT_LIMIT);
    expect(clampJournalListLimit(null)).toBe(JOURNAL_LIST_DEFAULT_LIMIT);
    expect(clampJournalListLimit("")).toBe(JOURNAL_LIST_DEFAULT_LIMIT);
    expect(clampJournalListLimit("abc")).toBe(JOURNAL_LIST_DEFAULT_LIMIT);
    expect(clampJournalListLimit("40px")).toBe(JOURNAL_LIST_DEFAULT_LIMIT);
    expect(clampJournalListLimit("40")).toBe(40);
    expect(clampJournalListLimit(40)).toBe(40);
    expect(clampJournalListLimit("0")).toBe(0);
    expect(clampJournalListLimit("-8")).toBe(0);
    expect(clampJournalListLimit("3.9")).toBe(3);
    expect(clampJournalListLimit(201)).toBe(JOURNAL_LIST_MAX_LIMIT);
    expect(clampJournalListLimit("999")).toBe(JOURNAL_LIST_MAX_LIMIT);
  });
});

describe("InMemoryJournal.list", () => {
  it("returns newest first and respects limit", async () => {
    const journal = new InMemoryJournal();
    journal.append(entry(1));
    journal.append(entry(2));
    journal.append(entry(3));

    await expect(journal.list(2)).resolves.toEqual([entry(3), entry(2)]);
    await expect(journal.list(40)).resolves.toEqual([entry(3), entry(2), entry(1)]);
    await expect(journal.list(0)).resolves.toEqual([]);
  });
});

describe("Journal.list", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  function tempJournal(): { journal: Journal; filePath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dialy-journal-"));
    dirs.push(dir);
    const filePath = path.join(dir, "operator.jsonl");
    return { journal: new Journal(filePath), filePath };
  }

  it("returns newest first without reading the whole file into a string", async () => {
    const { journal } = tempJournal();
    journal.append(entry(1));
    journal.append(entry(2));
    journal.append(entry(3));

    const spy = vi.spyOn(fs, "readFileSync");
    await expect(journal.list(2)).resolves.toEqual([entry(3), entry(2)]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips unparseable lines including a partial last line", async () => {
    const { journal, filePath } = tempJournal();
    journal.append(entry(1));
    journal.append(entry(2));
    fs.appendFileSync(filePath, "{not-json}\n", "utf8");
    journal.append(entry(3));
    fs.appendFileSync(filePath, '{"ts":"partial', "utf8");

    await expect(journal.list(10)).resolves.toEqual([entry(3), entry(2), entry(1)]);
  });

  it("reads only a tail window when the log is larger than 64KiB", async () => {
    const { journal } = tempJournal();
    const pad = "x".repeat(2048);
    for (let n = 1; n <= 50; n += 1) {
      journal.append({
        ts: `2026-08-30T10:00:00.${String(n).padStart(3, "0")}Z`,
        kind: "outcome",
        playbookId: "inbox",
        signalId: `sig-${n}`,
        data: { n, pad },
      });
    }

    const spy = vi.spyOn(fs, "readFileSync");
    const newest = await journal.list(2);
    expect(spy).not.toHaveBeenCalled();
    expect(newest.map((row) => row.data.n)).toEqual([50, 49]);
  });

  it("returns an empty list when the file is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dialy-journal-"));
    dirs.push(dir);
    const journal = new Journal(path.join(dir, "missing.jsonl"));
    await expect(journal.list(40)).resolves.toEqual([]);
  });
});
