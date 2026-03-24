import { LockOverlay } from "./overlay";

export interface LockScreenSettingsSnapshot {
  enabled: boolean;
  lockOnSystemLock: boolean;
  lockOnStartup: boolean;
  passcodeHash: string;
  passcodeSalt: string;
}

interface LockManagerOptions {
  getSettings: () => LockScreenSettingsSnapshot;
  verifyPasscode: (passcode: string) => Promise<boolean>;
  windowRef: Window;
  documentRef: Document;
  onLockStateChanged?: (locked: boolean) => void;
}

export class LockManager {
  private readonly overlay: LockOverlay;
  private locked = false;

  constructor(private readonly options: LockManagerOptions) {
    this.overlay = new LockOverlay(
      async (passcode) => this.attemptUnlock(passcode),
      options.windowRef,
      options.documentRef
    );
  }

  shouldLockOnStartup(): boolean {
    const settings = this.options.getSettings();
    return settings.enabled && settings.lockOnStartup && this.hasConfiguredPasscode();
  }

  lock(): void {
    if (this.locked || !this.canLock()) {
      return;
    }

    this.locked = true;
    this.overlay.show();
    this.options.onLockStateChanged?.(true);
  }

  unlock(): void {
    if (!this.locked) {
      return;
    }

    this.locked = false;
    this.overlay.hide();
    this.options.onLockStateChanged?.(false);
  }

  isLocked(): boolean {
    return this.locked;
  }

  teardown(): void {
    this.locked = false;
    this.overlay.destroy();
  }

  handleSystemLock(): void {
    if (this.shouldLockOnSystemLock()) {
      this.lock();
    }
  }

  handleWindowFocus(): void {
    if (this.locked) {
      this.overlay.show();
    }
  }

  handleGlobalKeyDown(event: KeyboardEvent): void {
    if (!this.locked) {
      return;
    }

    if (!this.options.documentRef.hasFocus()) {
      return;
    }

    if (!this.options.documentRef.hasFocus()) {
      return;
    }

    const root = this.overlay.getRoot();
    if (!root) {
      return;
    }

    const activeElement = this.options.documentRef.activeElement;
    const insideOverlay = activeElement ? root.contains(activeElement) : false;

    if (!insideOverlay) {
      event.preventDefault();
      event.stopPropagation();

      if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
        this.overlay.appendCharacter(event.key);
        return;
      }

      if (event.key === "Backspace") {
        this.overlay.deleteLastCharacter();
        return;
      }

      this.overlay.focusInput();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      return;
    }

    const inputTarget = this.isInputTarget(event.target);
    if (!inputTarget && !event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      event.preventDefault();
      this.overlay.appendCharacter(event.key);
      return;
    }

    if (!inputTarget && event.key === "Backspace") {
      event.preventDefault();
      this.overlay.deleteLastCharacter();
      return;
    }

    if (event.ctrlKey || event.metaKey || event.altKey) {
      if (!inputTarget) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const key = event.key.toLowerCase();
      const allowedKeys = new Set(["a", "c", "v", "x"]);
      if (!allowedKeys.has(key)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }
  }

  refreshForSettings(): void {
    if (!this.canLock()) {
      this.unlock();
    }
  }

  private async attemptUnlock(passcode: string): Promise<boolean> {
    const verified = await this.options.verifyPasscode(passcode);
    if (verified) {
      this.unlock();
      return true;
    }

    return false;
  }

  private shouldLockOnSystemLock(): boolean {
    const settings = this.options.getSettings();
    return settings.enabled && settings.lockOnSystemLock && this.hasConfiguredPasscode();
  }

  private canLock(): boolean {
    const settings = this.options.getSettings();
    return settings.enabled && this.hasConfiguredPasscode();
  }

  private hasConfiguredPasscode(): boolean {
    const settings = this.options.getSettings();
    return settings.passcodeHash.length > 0 && settings.passcodeSalt.length > 0;
  }

  private isInputTarget(target: EventTarget | null): target is HTMLInputElement {
    const maybeElement = target as { nodeType?: number; tagName?: string } | null;
    if (!maybeElement || maybeElement.nodeType !== 1 || typeof maybeElement.tagName !== "string") {
      return false;
    }

    return maybeElement.tagName.toLowerCase() === "input";
  }
}
