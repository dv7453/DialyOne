import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "../types.js";

export type CalendarAdapterConfig = {
  enabled?: boolean;
  credentials?: string;
};

export class CalendarAdapter implements CapabilityAdapter {
  readonly id = "calendar";
  readonly capabilities = ["calendar.create"];

  private readonly enabled: boolean;
  private readonly credentials?: string;

  constructor(config: CalendarAdapterConfig = {}) {
    this.enabled = config.enabled ?? process.env.CALENDAR_ENABLED === "true";
    this.credentials =
      config.credentials ?? process.env.GOOGLE_CALENDAR_CREDENTIALS ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }

  async isAvailable(): Promise<boolean> {
    return this.enabled && Boolean(this.credentials);
  }

  async execute(capability: string, args: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
    if (capability !== "calendar.create") {
      return { ok: false, capability, error: `Capability ${capability} is not supported by ${this.id}.` };
    }

    if (!(await this.isAvailable())) {
      return {
        ok: false,
        capability,
        unavailable: true,
        error: "Calendar adapter requires CALENDAR_ENABLED=true and Google Calendar credentials.",
      };
    }

    return {
      ok: true,
      capability,
      data: {
        event: {
          summary: args.summary ?? args.title,
          description: args.description,
          start: args.start,
          end: args.end,
          attendees: args.attendees,
          signalId: ctx.signalId,
        },
        created: false,
        message: "Calendar credentials are present; live Google Calendar create call is intentionally stubbed.",
      },
    };
  }
}
