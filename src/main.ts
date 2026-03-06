import { Notice, Platform, Plugin, type WorkspaceLeaf } from "obsidian";
import { LockManager, type LockScreenSettingsSnapshot } from "./lockManager";
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
}

const DEFAULT_SETTINGS: LockScreenSettings = {
  enabled: false,
  lockOnSystemLock: true,
  lockOnStartup: false,
  passcodeHash: "",
  passcodeSalt: "",
  hashIterations: 210_000,
  syncStateVersion: 0,
  syncLocked: false
};

export default class LockScreenPlugin extends Plugin {
  settings: LockScreenSettings = { ...DEFAULT_SETTINGS };
  private readonly windowManagers = new Map<Window, LockManager>();
  private readonly windowId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  private syncChannel: BroadcastChannel | null = null;
  private syncPollTimer: number | null = null;
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
    this.setupSystemLockListener();

    this.addSettingTab(new LockScreenSettingTab(this.app, this));

    this.addCommand({
      id: "lock-screen-now",
      name: "立即锁定工作区",
      callback: () => this.lockNow()
    });

    if (this.shouldLockOnStartup()) {
      this.lockAllWindows();
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

    for (const manager of this.windowManagers.values()) {
      manager.teardown();
    }
    this.windowManagers.clear();
  }

  hasConfiguredPasscode(): boolean {
    return this.settings.passcodeHash.length > 0 && this.settings.passcodeSalt.length > 0;
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<LockScreenSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(loaded ?? {}) };

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

    this.lockAllWindows();
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
    for (const manager of this.windowManagers.values()) {
      manager.lock();
    }
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
          this.applyLockToManager(manager, true);
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
      onLockStateChanged: (locked) => this.handleLockStateChangedFromManager(manager, locked)
    });

    this.windowManagers.set(win, manager);

    this.registerDomEvent(win, "focus", () => {
      manager.handleWindowFocus();

      if (this.settings.syncLocked || this.readGlobalLockState()) {
        this.applyLockToManager(manager, true);
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
      this.lockAllWindows();
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

  private handleLockStateChangedFromManager(originManager: LockManager, locked: boolean): void {
    const stateChanged = this.settings.syncLocked !== locked;

    const previousSuppress = this.suppressSyncBroadcast;
    this.suppressSyncBroadcast = true;
    for (const manager of this.windowManagers.values()) {
      if (manager === originManager) {
        continue;
      }

      this.applyLockToManager(manager, locked);
    }
    this.suppressSyncBroadcast = previousSuppress;

    if (!stateChanged) {
      return;
    }

    this.settings.syncLocked = locked;
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

  private handleSyncMessage(message: LockSyncMessage): void {
    if (!message || message.sourceWindowId === this.windowId) {
      return;
    }

    this.applyRemoteLockState(message.type === "lock");
  }

  private applyRemoteLockState(locked: boolean): void {
    this.suppressSyncBroadcast = true;
    for (const manager of this.windowManagers.values()) {
      this.applyLockToManager(manager, locked);
    }
    this.suppressSyncBroadcast = false;
    this.settings.syncLocked = locked;
  }

  private applyLockToManager(manager: LockManager, locked: boolean): void {
    if (locked) {
      manager.lock();
    } else {
      manager.unlock();
    }
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
