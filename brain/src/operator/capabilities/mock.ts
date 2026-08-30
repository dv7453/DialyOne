import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "./types.js";

export type MockCapabilityCall = {
  capability: string;
  args: Record<string, unknown>;
  ctx: CapabilityContext;
};

const MOCK_CAPABILITIES = [
  "deploy.health",
  "deploy.logs",
  "deploy.restart",
  "code.draft_pr",
  "mail.draft",
  "mail.send",
  "calendar.create",
  "notify.escalate",
  "journal.log",
  "web.fetch",
];

export class MockCapabilityAdapter implements CapabilityAdapter {
  readonly id = "mock";
  readonly capabilities = [...MOCK_CAPABILITIES];

  private readonly calls: MockCapabilityCall[] = [];
  private readonly responses = new Map<string, CapabilityResult>();

  constructor(responses?: Map<string, CapabilityResult> | Record<string, CapabilityResult>) {
    if (responses instanceof Map) {
      for (const [capability, result] of responses.entries()) {
        this.setResponse(capability, result);
      }
    } else if (responses) {
      for (const [capability, result] of Object.entries(responses)) {
        this.setResponse(capability, result);
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  setResponse(capability: string, result: CapabilityResult): void {
    this.responses.set(capability, { ...result, capability });
  }

  getCalls(): MockCapabilityCall[] {
    return this.calls.map((call) => ({
      capability: call.capability,
      args: { ...call.args },
      ctx: { ...call.ctx },
    }));
  }

  async execute(capability: string, args: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
    this.calls.push({ capability, args: { ...args }, ctx: { ...ctx } });

    return (
      this.responses.get(capability) ?? {
        ok: true,
        capability,
        data: { capability, args, ctx, mocked: true },
      }
    );
  }
}
