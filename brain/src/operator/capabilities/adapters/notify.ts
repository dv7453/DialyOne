import type { CapabilityAdapter, CapabilityContext, CapabilityResult } from "../types.js";

type FetchLike = typeof fetch;

export type NotifyMessage = {
  title: string;
  body: string;
  args: Record<string, unknown>;
  signalId?: string;
};

export interface NotifySink {
  id: string;
  isAvailable(): Promise<boolean>;
  send(message: NotifyMessage): Promise<void>;
}

export class ConsoleNotifySink implements NotifySink {
  readonly id = "console";

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async send(message: NotifyMessage): Promise<void> {
    console.info(`[notify.escalate] ${message.title}: ${message.body}`);
  }
}

export type TelegramNotifySinkConfig = {
  botToken?: string;
  chatId?: string;
  fetchImpl?: FetchLike;
};

export class TelegramNotifySink implements NotifySink {
  readonly id = "telegram";

  private readonly botToken?: string;
  private readonly chatId?: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: TelegramNotifySinkConfig = {}) {
    this.botToken = config.botToken ?? process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = config.chatId ?? process.env.TELEGRAM_NOTIFY_CHAT_ID;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.botToken && this.chatId);
  }

  async send(message: NotifyMessage): Promise<void> {
    if (!(await this.isAvailable()) || !this.botToken || !this.chatId) {
      throw new Error("Telegram notify sink requires TELEGRAM_BOT_TOKEN and TELEGRAM_NOTIFY_CHAT_ID.");
    }

    const response = await this.fetchImpl(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text: `${message.title}\n\n${message.body}`,
      }),
    });

    if (!response.ok) {
      throw new Error(`Telegram notify failed with status ${response.status}.`);
    }
  }
}

export class NotifyAdapter implements CapabilityAdapter {
  readonly id = "notify";
  readonly capabilities = ["notify.escalate"];

  constructor(private readonly sinks: NotifySink[] = [new TelegramNotifySink(), new ConsoleNotifySink()]) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async execute(capability: string, args: Record<string, unknown>, ctx: CapabilityContext): Promise<CapabilityResult> {
    if (capability !== "notify.escalate") {
      return { ok: false, capability, error: `Capability ${capability} is not supported by ${this.id}.` };
    }

    const message = buildMessage(args, ctx);
    const delivered: string[] = [];
    const failed: Array<{ sink: string; error: string }> = [];

    for (const sink of this.sinks) {
      if (!(await sink.isAvailable())) {
        continue;
      }

      try {
        await sink.send(message);
        delivered.push(sink.id);
      } catch (error) {
        failed.push({ sink: sink.id, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return {
      ok: delivered.length > 0,
      capability,
      error: delivered.length > 0 ? undefined : "No notification sink delivered the escalation.",
      data: { delivered, failed, message },
    };
  }
}

function buildMessage(args: Record<string, unknown>, ctx: CapabilityContext): NotifyMessage {
  return {
    title: typeof args.title === "string" ? args.title : "Dialy operator escalation",
    body: typeof args.body === "string" ? args.body : JSON.stringify(args, null, 2),
    args,
    signalId: ctx.signalId,
  };
}
