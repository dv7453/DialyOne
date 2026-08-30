import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "../types.js";

type FetchLike = typeof fetch;

export type GitHubCodeAdapterConfig = {
  token?: string;
  repo?: string;
  fetchImpl?: FetchLike;
};

export class GitHubCodeAdapter implements CapabilityAdapter {
  readonly id = "code-github";
  readonly capabilities = ["code.draft_pr"];

  private readonly token?: string;
  private readonly repo?: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: GitHubCodeAdapterConfig = {}) {
    this.token = config.token ?? process.env.GITHUB_TOKEN;
    this.repo = config.repo ?? process.env.GITHUB_REPO;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.token && this.repo);
  }

  async execute(capability: string, args: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
    if (capability !== "code.draft_pr") {
      return { ok: false, capability, error: `Capability ${capability} is not supported by ${this.id}.` };
    }

    if (!(await this.isAvailable()) || !this.token || !this.repo) {
      return {
        ok: false,
        capability,
        unavailable: true,
        error: "GitHub code adapter requires GITHUB_TOKEN and GITHUB_REPO.",
      };
    }

    const plan = buildDraftPullRequestPlan(args, ctx);
    const shouldCreate = args.dryRun === false && args.confirmed === true;
    if (!shouldCreate) {
      return {
        ok: true,
        capability,
        data: { dryRun: true, repo: this.repo, pullRequest: plan },
      };
    }

    if (!plan.title || !plan.head || !plan.base) {
      return {
        ok: false,
        capability,
        error: "Creating a draft PR requires title, head, and base.",
        data: { pullRequest: plan },
      };
    }

    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title: plan.title,
        body: plan.body,
        head: plan.head,
        base: plan.base,
        maintainer_can_modify: plan.maintainer_can_modify,
        draft: true,
      }),
    });

    const body = await readResponseBody(response);
    if (!response.ok) {
      return {
        ok: false,
        capability,
        error: `GitHub draft PR request failed with status ${response.status}.`,
        data: { status: response.status, body },
      };
    }

    return { ok: true, capability, data: { pullRequest: body } };
  }
}

function buildDraftPullRequestPlan(args: Record<string, unknown>, ctx: CapabilityContext): Record<string, unknown> {
  return {
    title: typeof args.title === "string" ? args.title : undefined,
    body: typeof args.body === "string" ? args.body : undefined,
    head: typeof args.head === "string" ? args.head : typeof args.branch === "string" ? args.branch : undefined,
    base: typeof args.base === "string" ? args.base : "main",
    maintainer_can_modify: args.maintainer_can_modify !== false,
    signalId: ctx.signalId,
  };
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
