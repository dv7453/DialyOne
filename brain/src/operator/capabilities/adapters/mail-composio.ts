import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "../types.js";

export type MailAdapterConfig = {
  apiKey?: string;
};

export class MailAdapter implements CapabilityAdapter {
  readonly id = "mail-composio";
  readonly capabilities = ["mail.draft", "mail.send"];

  private readonly apiKey?: string;

  constructor(config: MailAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.COMPOSIO_API_KEY;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async execute(capability: string, args: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
    if (!(await this.isAvailable())) {
      return {
        ok: false,
        capability,
        unavailable: true,
        error: "Mail adapter requires COMPOSIO_API_KEY.",
      };
    }

    const draft = buildDraftPayload(args, ctx);
    if (capability === "mail.draft") {
      return {
        ok: true,
        capability,
        data: { draft, provider: "composio", sent: false },
      };
    }

    if (capability === "mail.send") {
      if (args.confirmed !== true) {
        return {
          ok: false,
          capability,
          error: "mail.send requires confirmed=true before any send-capable path is used.",
          data: { draft, needsApproval: true, sent: false },
        };
      }

      return {
        ok: true,
        capability,
        data: {
          draft,
          provider: "composio",
          sent: false,
          message: "Send confirmed; live Composio send call is intentionally disabled in this adapter.",
        },
      };
    }

    return { ok: false, capability, error: `Capability ${capability} is not supported by ${this.id}.` };
  }
}

function buildDraftPayload(args: Record<string, unknown>, ctx: CapabilityContext): Record<string, unknown> {
  return {
    to: args.to,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    body: args.body,
    signalId: ctx.signalId,
  };
}
