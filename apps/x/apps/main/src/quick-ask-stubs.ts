/**
 * No-op stand-ins for the deleted Quick Ask companion window.
 * IPC channels and video popout relays still reference these shapes;
 * they do nothing until a later group removes those surfaces.
 */

import { DEFAULT_QUICK_ASK_SHORTCUT } from "@x/shared/src/quick-ask-shortcut.js";

export type CompanionMode = "hidden" | "pinned";
export type ExpandedSurface = "card" | "pill";

export function initQuickAsk(_opts?: { ensureAppWindow?: () => void }): void {}
export function onAppWindowClosed(): void {}

export function getQuickAskShortcutState() {
  return {
    accelerator: DEFAULT_QUICK_ASK_SHORTCUT,
    registered: false,
    isDefault: true,
  };
}

export function setQuickAskShortcut(accelerator: string | null) {
  return {
    ok: false as const,
    accelerator: accelerator ?? DEFAULT_QUICK_ASK_SHORTCUT,
    registered: false,
    error: "Quick Ask has been removed",
  };
}

export function setShortcutCaptureActive(_active: boolean): void {}
export function onQuickAskShortcutChanged(_cb: () => void): () => void {
  return () => {};
}
export function toggleQuickAsk(): void {}

export function getCompanionMode(): CompanionMode {
  return "hidden";
}
export function getModeSeq(): number {
  return 0;
}
export function getExpandedSurface(): ExpandedSurface {
  return "card";
}
export function getPopoutState(): null {
  return null;
}
export function onAppReady(): void {}
export function onModeApplied(_seq: number): void {}
export function isPinnedCollapsed(): boolean {
  return false;
}
export function relaySummon(): void {}
export function ackSummon(): void {}
export function pushChatContext(_args: unknown): void {}
export function pushPopoutState(_args: unknown): void {}
export function resizeCompanionPinned(_height: number): void {}
export function setCompanionPinned(_show: boolean): void {}
export function setPinnedCollapsed(_collapsed: boolean): void {}
export function setCompanionInteractive(_interactive: boolean): void {}
