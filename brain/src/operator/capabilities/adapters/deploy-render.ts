import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "../types.js";

type FetchLike = typeof fetch;

export type RenderDeployAdapterConfig = {
  apiKey?: string;
  serviceId?: string;
  fetchImpl?: FetchLike;
};

export class RenderDeployAdapter implements CapabilityAdapter {
  readonly id = "deploy-render";
  readonly capabilities = ["deploy.health", "deploy.logs", "deploy.restart"];

  private readonly apiKey?: string;
  private readonly serviceId?: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: RenderDeployAdapterConfig = {}) {
    this.apiKey = config.apiKey ?? process.env.RENDER_API_KEY;
    this.serviceId = config.serviceId ?? process.env.RENDER_SERVICE_ID;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey && this.serviceId);
  }

  async execute(capability: string, args: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
    if (!(await this.isAvailable())) {
      return {
        ok: false,
        capability,
        unavailable: true,
        error: "Render deploy adapter requires RENDER_API_KEY and RENDER_SERVICE_ID.",
      };
    }

    switch (capability) {
      case "deploy.health":
        return this.getServiceHealth(ctx);
      case "deploy.logs":
        return {
          ok: true,
          capability,
          data: {
            message: "Render log retrieval is configured; a live logs call would go here when a stable endpoint is selected.",
            args,
            signalId: ctx.signalId,
          },
        };
      case "deploy.restart":
        return {
          ok: false,
          capability,
          error: "Render restart requires an explicit approval path and confirmed API endpoint before execution.",
          data: { args, signalId: ctx.signalId },
        };
      default:
        return { ok: false, capability, error: `Capability ${capability} is not supported by ${this.id}.` };
    }
  }

  private async getServiceHealth(ctx: CapabilityContext): Promise<CapabilityResult> {
    const capability = "deploy.health";
    const response = await this.fetchImpl(`https://api.render.com/v1/services/${this.serviceId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
      },
    });

    const body = await readResponseBody(response);
    if (!response.ok) {
      return {
        ok: false,
        capability,
        error: `Render service health request failed with status ${response.status}.`,
        data: { status: response.status, body, signalId: ctx.signalId },
      };
    }

    return {
      ok: true,
      capability,
      data: { service: body, signalId: ctx.signalId },
    };
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
