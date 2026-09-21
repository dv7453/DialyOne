import { describe, expect, it } from "vitest";

import { InMemoryJournal } from "../../journal.js";
import { JournalLogAdapter } from "./journal-log.js";

const now = () => "2026-01-01T00:00:00.000Z";

describe("JournalLogAdapter", () => {
  it("appends an entry carrying the playbook args and context", async () => {
    const journal = new InMemoryJournal();
    const adapter = new JournalLogAdapter(journal, { now });

    const result = await adapter.execute(
      "journal.log",
      { summary: "morning-brief" },
      { signalId: "sig-1", playbookId: "morning-brief" },
    );

    expect(result.ok).toBe(true);
    expect(journal.readAll()).toEqual([
      {
        ts: now(),
        kind: "outcome",
        playbookId: "morning-brief",
        signalId: "sig-1",
        data: { via: "journal.log", summary: "morning-brief" },
      },
    ]);
  });

  it("honours a caller-supplied kind and falls back to outcome for unknown kinds", async () => {
    const journal = new InMemoryJournal();
    const adapter = new JournalLogAdapter(journal, { now });

    await adapter.execute("journal.log", { kind: "decision" }, {});
    await adapter.execute("journal.log", { kind: "not-a-kind" }, {});

    expect(journal.readAll().map((entry) => entry.kind)).toEqual(["decision", "outcome"]);
  });

  it("omits optional context fields when they are absent", async () => {
    const journal = new InMemoryJournal();
    const adapter = new JournalLogAdapter(journal, { now });

    await adapter.execute("journal.log", {}, {});

    expect(journal.readAll()[0]).toEqual({
      ts: now(),
      kind: "outcome",
      data: { via: "journal.log" },
    });
  });

  it("rejects capabilities it does not own", async () => {
    const adapter = new JournalLogAdapter(new InMemoryJournal(), { now });

    await expect(adapter.execute("mail.send", {}, {})).resolves.toMatchObject({
      ok: false,
      capability: "mail.send",
    });
  });

  it("reports a failed result when the journal write throws", async () => {
    const adapter = new JournalLogAdapter(
      {
        append() {
          throw new Error("disk full");
        },
        async list() {
          return [];
        },
      },
      { now },
    );

    await expect(adapter.execute("journal.log", {}, {})).resolves.toMatchObject({
      ok: false,
      capability: "journal.log",
      error: "disk full",
    });
  });
});
