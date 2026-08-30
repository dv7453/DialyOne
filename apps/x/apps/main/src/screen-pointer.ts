/**
 * No-op screen-pointer service (product UI removed).
 * Keeps DI + IPC contracts so brain catalog tools still resolve without overlay windows.
 */
import type {
  IScreenPointerService,
  ScreenPointerResult,
  ScreenPointerTarget,
} from '@x/core/dist/application/screen-pointer/service.js';

export type PointerOverlayState = {
  visible: boolean;
  x: number;
  y: number;
  label: string | null;
  nonce: number;
};

export class ElectronScreenPointerService implements IScreenPointerService {
  private shareActive = false;
  private lastState: PointerOverlayState | null = null;

  setShareActive(active: boolean): void {
    this.shareActive = active;
    if (!active) this.lastState = null;
  }

  isShareActive(): boolean {
    return this.shareActive;
  }

  getState(): PointerOverlayState | null {
    return this.lastState;
  }

  async point(_target: ScreenPointerTarget): Promise<ScreenPointerResult> {
    return { success: false, error: 'screen pointer UI removed' };
  }

  async hide(): Promise<void> {
    this.lastState = null;
  }
}

export const screenPointerService = new ElectronScreenPointerService();
