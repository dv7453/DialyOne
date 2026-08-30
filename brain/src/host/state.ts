export type HostRuntimeState = {
    startedAt: number;
    bootOk: boolean;
    bootError?: string;
    /** True when no channel turn is in flight. */
    modelIdle: boolean;
    lastWakeAt: number | null;
    lastIdleAt: number | null;
    lastInboundAt: number | null;
    lastInboundChannel: string | null;
    lastTurnId: string | null;
    lastModelCallAt: number | null;
    services: string[];
    http: { host: string; port: number } | null;
};

export const hostState: HostRuntimeState = {
    startedAt: Date.now(),
    bootOk: false,
    modelIdle: true,
    lastWakeAt: null,
    lastIdleAt: null,
    lastInboundAt: null,
    lastInboundChannel: null,
    lastTurnId: null,
    lastModelCallAt: null,
    services: [],
    http: null,
};

export function recordInbound(senderKey: string): void {
    hostState.lastInboundAt = Date.now();
    const channel = senderKey.includes(":")
        ? senderKey.slice(0, senderKey.indexOf(":"))
        : senderKey;
    hostState.lastInboundChannel = channel;
}

export function markWake(turnId?: string): void {
    hostState.modelIdle = false;
    hostState.lastWakeAt = Date.now();
    hostState.lastModelCallAt = Date.now();
    if (turnId) hostState.lastTurnId = turnId;
}

export function markIdle(): void {
    hostState.modelIdle = true;
    hostState.lastIdleAt = Date.now();
}
