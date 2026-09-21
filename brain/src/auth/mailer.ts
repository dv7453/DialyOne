export type MagicLinkMessage = {
    email: string;
    magicLinkUrl: string;
    expiresAt: Date;
};

export interface MagicLinkMailer {
    sendMagicLink(message: MagicLinkMessage): Promise<void>;
}

export class ConsoleMagicLinkMailer implements MagicLinkMailer {
    async sendMagicLink(message: MagicLinkMessage): Promise<void> {
        console.info(
            `[dialy-auth] magic link for ${message.email} → ${message.magicLinkUrl} (expires ${message.expiresAt.toISOString()})`,
        );
    }
}
