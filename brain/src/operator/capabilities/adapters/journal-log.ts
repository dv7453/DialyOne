import type { JournalWriter } from "../../journal.js";
import type { JournalEntry } from "../../types.js";
import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "../types.js";

type JournalKind = JournalEntry["kind"];

const JOURNAL_KINDS: readonly JournalKind[] = ["signal", "decision", "action", "outcome", "escalate"];

function resolveKind(value: unknown): JournalKind {
  return typeof value === "string" && (JOURNAL_KINDS as readonly string[]).includes(value)
    ? (value as JournalKind)
    : "outcome";
}

export type JournalLogAdapterOptions = {
  now?: () => string;
};

export class JournalLogAdapter implements CapabilityAdapter {
  readonly id = "journal";
  readonly capabilities = ["journal.log"];

  private readonly now: () => string;

  constructor(
    private readonly journal: JournalWriter,
    options: JournalLogAdapterOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async execute(capability: string, args: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
    if (capability !== "journal.log") {
      return { ok: false, capability, error: `Capability ${capability} is not supported by ${this.id}.` };
    }

    const { kind, ...rest } = args;
    const entry: JournalEntry = {
      ts: this.now(),
      kind: resolveKind(kind),
      ...(ctx.playbookId ? { playbookId: ctx.playbookId } : {}),
      ...(ctx.signalId ? { signalId: ctx.signalId } : {}),
      data: { via: "journal.log", ...rest },
    };

    try {
      await this.journal.append(entry);
      return { ok: true, capability, data: { entry } };
    } catch (error) {
      return {
        ok: false,
        capability,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
