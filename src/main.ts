import { Notice, Platform, Plugin, type WorkspaceLeaf } from "obsidian";
import { LockManager, type LockScreenSettingsSnapshot } from "./lockManager";
import {
  DEFAULT_QUICK_NOTE_SETTINGS,
  QuickCaptureService,
  type QuickNoteSettings
} from "./quickCapture";
import { constantTimeEqual, createSalt, hashPasscode } from "./security";
import { LockScreenSettingTab } from "./settings";

const GLOBAL_LOCK_STATE_KEY = "lock-screen:global-locked";
const GLOBAL_SYNC_CHANNEL = "lock-screen:sync";

type LockSyncMessage = {
  type: "lock" | "unlock";
  sourceWindowId: string;
};

export interface LockScreenSettings extends LockScreenSettingsSnapshot {
  hashIterations: number;
  syncStateVersion: number;
  syncLocked: boolean;
  quickNote: QuickNoteSettings;
}

const DEFAULT_SETTINGS: LockScreenSettings = {
  enabled: false,
  lockOnSystemLock: true,
  lockOnStartup: false,
  passcodeHash: "",
  passcodeSalt: "",
  hashIterations: 210_000,
  syncStateVersion: 0,
  syncLocked: false,
  quickNote: { ...DEFAULT_QUICK_NOTE_SETTINGS }
};

export default class LockScreenPlugin extends Plugin {
  settings: LockScreenSettings = { ...DEFAULT_SETTINGS };
  private readonly windowManagers = new Map<Window, LockManager>();
  private settingsTab: LockScreenSettingTab | null = null;
  private quickCaptureService: QuickCaptureService | null = null;
  private readonly windowId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  private syncChannel: BroadcastChannel | null = null;
  private syncPollTimer: number | null = null;
  private windowPolicyTimer: number | null = null;
  private suppressSyncBroadcast = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    if (!Platform.isDesktopApp) {
      new Notice("锁屏插件仅支持 Obsidian 桌面端。", 5000);
      return;
    }

    this.setupWorkspaceWindowTracking();
    this.setupCrossWindowSync();
    this.setupDiskSyncFallback();
    this.setupWindowPolicyWatcher();
    this.setupSystemLockListener();

    this.quickCaptureService = new QuickCaptureService(this);
    this.quickCaptureService.onload();

    this.settingsTab = new LockScreenSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    this.addCommand({
      id: "lock-screen-now",
      name: "立即锁定工作区",
      callback: () => this.lockNow()
    });

    if (this.shouldLockOnStartup()) {
      this.requestGlobalLockState(true);
    }

    if (this.settings.syncLocked || this.readGlobalLockState()) {
      this.applyRemoteLockState(true);
    }
  }

  onunload(): void {
    this.syncChannel?.close();
    this.syncChannel = null;

    if (this.syncPollTimer !== null) {
      window.clearInterval(this.syncPollTimer);
      this.syncPollTimer = null;
    }

    if (this.windowPolicyTimer !== null) {
      window.clearInterval(this.windowPolicyTimer);
      this.windowPolicyTimer = null;
    }

    for (const manager of this.windowManagers.values()) {
      manager.teardown();
    }
    this.windowManagers.clear();

    this.quickCaptureService?.onunload();
    this.quickCaptureService = null;
    this.settingsTab = null;
  }

  hasConfiguredPasscode(): boolean {
    return this.settings.passcodeHash.length > 0 && this.settings.passcodeSalt.length > 0;
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<LockScreenSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };

    this.settings.quickNote = {
      ...DEFAULT_QUICK_NOTE_SETTINGS,
      ...(loaded?.quickNote ?? {})
    };

    if (loaded?.lockOnSystemLock === undefined) {
      const legacyLockOnHide = (loaded as Partial<{ lockOnHide: boolean }> | null)?.lockOnHide;
      if (legacyLockOnHide !== undefined) {
        this.settings.lockOnSystemLock = legacyLockOnHide;
      }
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  refreshSettingsTab(): void {
    this.settingsTab?.display();
  }

  renderQuickCaptureSettings(containerEl: HTMLElement): void {
    this.quickCaptureService?.renderSettings(containerEl);
  }

  async configurePasscode(passcode: string): Promise<void> {
    if (!crypto?.subtle) {
      throw new Error("Web Crypto is unavailable in this runtime.");
    }

    const salt = createSalt();
    const hash = await hashPasscode(passcode, salt, this.settings.hashIterations);

    this.settings.passcodeSalt = salt;
    this.settings.passcodeHash = hash;
    await this.saveSettings();
    this.refreshLockState();
  }

  async clearPasscode(): Promise<void> {
    this.settings.passcodeSalt = "";
    this.settings.passcodeHash = "";
    await this.saveSettings();
    this.refreshLockState();
  }

  lockNow(): void {
    if (!this.settings.enabled) {
      new Notice("请先启用锁屏功能。", 4000);
      return;
    }

    if (!this.hasConfiguredPasscode()) {
      new Notice("请先设置访问授权码。", 4000);
      return;
    }

    this.requestGlobalLockState(true);
  }

  openQuickCapture(): void {
    this.quickCaptureService?.openFromExternalTrigger();
  }

  refreshLockState(): void {
    for (const manager of this.windowManagers.values()) {
      manager.refreshForSettings();
    }
  }

  private shouldLockOnStartup(): boolean {
    return this.settings.enabled && this.settings.lockOnStartup && this.hasConfiguredPasscode();
  }

  private lockAllWindows(): void {
    this.applyLockPolicyToAllWindows(true);
  }

  private async verifyPasscode(passcode: string): Promise<boolean> {
    if (!this.hasConfiguredPasscode()) {
      return false;
    }

    const hash = await hashPasscode(
      passcode,
      this.settings.passcodeSalt,
      this.settings.hashIterations
    );

    return constantTimeEqual(hash, this.settings.passcodeHash);
  }

  private setupWorkspaceWindowTracking(): void {
    const allWindows = new Set<Window>([window]);

    this.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
      const container = leaf.getContainer();
      if (container?.win) {
        allWindows.add(container.win);
      }
    });

    for (const win of allWindows) {
      this.ensureWindowManager(win);
    }

    this.registerEvent(
      this.app.workspace.on("window-open", (_workspaceWindow, win) => {
        const manager = this.ensureWindowManager(win);
        if (this.settings.syncLocked || this.readGlobalLockState()) {
          this.applyLockPolicyToManagerSilently(win, manager, true);
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("window-close", (_workspaceWindow, win) => {
        this.removeWindowManager(win);
      })
    );
  }

  private ensureWindowManager(win: Window): LockManager {
    const existing = this.windowManagers.get(win);
    if (existing) {
      return existing;
    }

    let manager: LockManager;
    manager = new LockManager({
      getSettings: () => this.settings,
      verifyPasscode: async (passcode) => this.verifyPasscode(passcode),
      windowRef: win,
      documentRef: win.document,
      onLockStateChanged: (locked) => this.handleLockStateChangedFromManager(win, manager, locked)
    });

    this.windowManagers.set(win, manager);

    this.registerDomEvent(win, "focus", () => {
      manager.handleWindowFocus();

      if (this.settings.syncLocked || this.readGlobalLockState()) {
        this.applyLockPolicyToManagerSilently(win, manager, true);
      }
    });

    this.registerDomEvent(
      win,
      "keydown",
      (event) => {
        manager.handleGlobalKeyDown(event);
      },
      { capture: true }
    );

    return manager;
  }

  private removeWindowManager(win: Window): void {
    const manager = this.windowManagers.get(win);
    if (!manager) {
      return;
    }

    manager.teardown();
    this.windowManagers.delete(win);
  }

  private setupSystemLockListener(): void {
    type PowerMonitorLike = {
      on: (event: "lock-screen", handler: () => void) => void;
      removeListener: (event: "lock-screen", handler: () => void) => void;
    };

    type ElectronLike = {
      powerMonitor?: PowerMonitorLike;
      remote?: {
        powerMonitor?: PowerMonitorLike;
      };
    };

    let electronModule: ElectronLike | null = null;

    try {
      const unsafeWindow = window as unknown as { require?: (id: string) => ElectronLike };
      if (unsafeWindow.require) {
        electronModule = unsafeWindow.require("electron");
      }
    } catch {
      electronModule = null;
    }

    const powerMonitor = electronModule?.powerMonitor ?? electronModule?.remote?.powerMonitor;
    if (!powerMonitor) {
      new Notice("未检测到系统锁屏事件通道，自动锁定仅可手动触发。", 5000);
      return;
    }

    const onSystemLock = (): void => {
      if (!this.settings.enabled || !this.hasConfiguredPasscode() || !this.settings.lockOnSystemLock) {
        return;
      }

      this.requestGlobalLockState(true);
    };

    powerMonitor.on("lock-screen", onSystemLock);
    this.register(() => {
      powerMonitor.removeListener("lock-screen", onSystemLock);
    });
  }

  private setupCrossWindowSync(): void {
    if (typeof BroadcastChannel !== "undefined") {
      this.syncChannel = new BroadcastChannel(GLOBAL_SYNC_CHANNEL);
      this.syncChannel.onmessage = (event: MessageEvent<LockSyncMessage>) => {
        this.handleSyncMessage(event.data);
      };

      this.register(() => {
        this.syncChannel?.close();
        this.syncChannel = null;
      });
    }

    this.registerDomEvent(window, "storage", (event: StorageEvent) => {
      if (event.key !== GLOBAL_LOCK_STATE_KEY) {
        return;
      }

      const locked = event.newValue === "1";
      this.applyRemoteLockState(locked);
    });
  }

  private handleLockStateChangedFromManager(
    originWindow: Window,
    originManager: LockManager,
    locked: boolean
  ): void {
    if (this.suppressSyncBroadcast) {
      return;
    }

    if (locked && this.isWindowExempt(originWindow)) {
      const previousSuppress = this.suppressSyncBroadcast;
      this.suppressSyncBroadcast = true;
      originManager.unlock();
      this.suppressSyncBroadcast = previousSuppress;
      return;
    }

    void originWindow;
    void originManager;
    this.requestGlobalLockState(locked);
  }

  private handleSyncMessage(message: LockSyncMessage): void {
    if (!message || message.sourceWindowId === this.windowId) {
      return;
    }

    this.applyRemoteLockState(message.type === "lock");
  }

  private applyRemoteLockState(locked: boolean): void {
    this.applyLockPolicyToAllWindows(locked);
    this.settings.syncLocked = locked;
  }

  private requestGlobalLockState(locked: boolean): void {
    if (this.settings.syncLocked === locked) {
      this.applyRemoteLockState(locked);
      return;
    }

    this.applyRemoteLockState(locked);
    this.writeGlobalLockState(locked);
    void this.persistGlobalLockState(locked);

    if (this.suppressSyncBroadcast) {
      return;
    }

    const message: LockSyncMessage = {
      type: locked ? "lock" : "unlock",
      sourceWindowId: this.windowId
    };

    this.syncChannel?.postMessage(message);
  }

  private applyLockPolicyToAllWindows(locked: boolean): void {
    const previousSuppress = this.suppressSyncBroadcast;
    this.suppressSyncBroadcast = true;
    for (const [win, manager] of this.windowManagers.entries()) {
      this.applyLockPolicyToManager(win, manager, locked);
    }
    this.suppressSyncBroadcast = previousSuppress;
  }

  private applyLockPolicyToManager(win: Window, manager: LockManager, locked: boolean): void {
    const shouldStayUnlocked = this.isWindowExempt(win);
    if (!locked || shouldStayUnlocked) {
      manager.unlock();
      return;
    }

    manager.lock();
  }

  private applyLockPolicyToManagerSilently(win: Window, manager: LockManager, locked: boolean): void {
    const previousSuppress = this.suppressSyncBroadcast;
    this.suppressSyncBroadcast = true;
    this.applyLockPolicyToManager(win, manager, locked);
    this.suppressSyncBroadcast = previousSuppress;
  }

  private setupWindowPolicyWatcher(): void {
    this.windowPolicyTimer = window.setInterval(() => {
      const globalLocked = this.settings.syncLocked || this.readGlobalLockState();
      this.applyLockPolicyToAllWindows(globalLocked);
    }, 400);

    this.register(() => {
      if (this.windowPolicyTimer !== null) {
        window.clearInterval(this.windowPolicyTimer);
        this.windowPolicyTimer = null;
      }
    });
  }

  private isWindowExempt(win: Window): boolean {
    const rawWindow = win as unknown as {
      __LOCK_SCREEN_EXEMPT__?: boolean;
    };

    if (rawWindow.__LOCK_SCREEN_EXEMPT__ === true) {
      return true;
    }

    const doc = win.document;
    const htmlFlag = doc.documentElement.getAttribute("data-lockscreen-exempt");
    if (htmlFlag === "true") {
      return true;
    }

    const bodyFlag = doc.body?.getAttribute("data-lockscreen-exempt");
    return bodyFlag === "true";
  }

  private setupDiskSyncFallback(): void {
    this.syncPollTimer = window.setInterval(() => {
      void this.pullGlobalStateFromDisk();
    }, 1000);

    this.register(() => {
      if (this.syncPollTimer !== null) {
        window.clearInterval(this.syncPollTimer);
        this.syncPollTimer = null;
      }
    });
  }

  private async pullGlobalStateFromDisk(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<LockScreenSettings> | null;
    if (!loaded) {
      return;
    }

    const remoteVersion = loaded.syncStateVersion ?? 0;
    const remoteLocked = loaded.syncLocked ?? false;
    if (remoteVersion <= this.settings.syncStateVersion) {
      return;
    }

    this.settings.syncStateVersion = remoteVersion;
    this.settings.syncLocked = remoteLocked;
    this.applyRemoteLockState(remoteLocked);
  }

  private async persistGlobalLockState(locked: boolean): Promise<void> {
    if (this.suppressSyncBroadcast) {
      this.settings.syncLocked = locked;
      return;
    }

    this.settings.syncLocked = locked;
    this.settings.syncStateVersion += 1;
    await this.saveSettings();
  }

  private readGlobalLockState(): boolean {
    try {
      return localStorage.getItem(GLOBAL_LOCK_STATE_KEY) === "1";
    } catch {
      return false;
    }
  }

  private writeGlobalLockState(locked: boolean): void {
    try {
      localStorage.setItem(GLOBAL_LOCK_STATE_KEY, locked ? "1" : "0");
    } catch {
      return;
    }
  }
}
