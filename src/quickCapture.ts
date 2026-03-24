import {
  Notice,
  Setting,
  TAbstractFile,
  TFile,
  TFolder,
  WorkspaceLeaf,
  normalizePath
} from "obsidian";
import type LockScreenPlugin from "./main";

export type SaveTarget = "daily" | "new-file";

export interface QuickNoteSettings {
  enabled: boolean;
  useGlobalShortcut: boolean;
  globalShortcut: string;
  saveTarget: SaveTarget;
  dailyFolder: string;
  dailyFileNamePattern: string;
  newFileFolder: string;
  newFileNamePrefix: string;
}

interface CaptureSession {
  leaf: WorkspaceLeaf;
  filePath: string;
  closeArmed: boolean;
  unbindSaveHotkey?: () => void;
  popupWindow?: Window;
}

interface CloseSessionOptions {
  closeLeaf: boolean;
}

export const DEFAULT_QUICK_NOTE_SETTINGS: QuickNoteSettings = {
  enabled: true,
  useGlobalShortcut: false,
  globalShortcut: "CommandOrControl+Shift+Q",
  saveTarget: "daily",
  dailyFolder: "",
  dailyFileNamePattern: "YYYY-MM-DD",
  newFileFolder: "QuickNotes",
  newFileNamePrefix: "QuickNote"
};

export class QuickCaptureService {
  private captureSession: CaptureSession | null = null;
  private registeredShortcut: string | null = null;

  constructor(private readonly plugin: LockScreenPlugin) {}

  onload(): void {
    this.plugin.addCommand({
      id: "open-quick-note-window",
      name: "打开快捷记录窗口",
      callback: () => {
        this.scheduleOpenQuickNoteWindow();
      }
    });

    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (file: TAbstractFile) => {
        void this.handleTempFileModify(file);
      })
    );

    this.plugin.registerEvent(
      this.plugin.app.workspace.on("window-close", () => {
        void this.cleanupOrphanSession();
      })
    );

    this.registerGlobalShortcut();
  }

  openFromExternalTrigger(): void {
    this.scheduleOpenQuickNoteWindow();
  }

  onunload(): void {
    this.unregisterGlobalShortcut();
    void this.closeCaptureSession({ closeLeaf: false });
  }

  renderSettings(containerEl: HTMLElement): void {
    const settings = this.plugin.settings.quickNote;

    containerEl.createEl("h2", { text: "快捷记录设置" });

    new Setting(containerEl)
      .setName("启用快捷记录")
      .setDesc("启用后可通过命令面板打开快捷记录弹窗。")
      .addToggle((toggle) =>
        toggle.setValue(settings.enabled).onChange(async (value) => {
          this.plugin.settings.quickNote.enabled = value;
          await this.plugin.saveSettings();
          this.registerGlobalShortcut();
        })
      );

    new Setting(containerEl)
      .setName("启用内置全局热键")
      .setDesc("使用当前插件直接注册 Electron 全局热键，绕开 Global Hotkeys。")
      .addToggle((toggle) =>
        toggle.setValue(settings.useGlobalShortcut).onChange(async (value) => {
          this.plugin.settings.quickNote.useGlobalShortcut = value;
          await this.plugin.saveSettings();
          this.registerGlobalShortcut();
        })
      );

    new Setting(containerEl)
      .setName("全局热键")
      .setDesc("采用 Electron Accelerator 格式，例如 CommandOrControl+Shift+Q。")
      .addText((text) =>
        text
          .setPlaceholder("CommandOrControl+Shift+Q")
          .setValue(settings.globalShortcut)
          .onChange(async (value) => {
            this.plugin.settings.quickNote.globalShortcut = value.trim() || "CommandOrControl+Shift+Q";
            await this.plugin.saveSettings();
            this.registerGlobalShortcut();
          })
      );

    new Setting(containerEl)
      .setName("记录位置")
      .setDesc("选择保存到今日日记或新建文件。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("daily", "今日日记中")
          .addOption("new-file", "新建文件")
          .setValue(settings.saveTarget)
          .onChange(async (value) => {
            this.plugin.settings.quickNote.saveTarget = value as SaveTarget;
            await this.plugin.saveSettings();
            this.plugin.refreshSettingsTab();
          })
      );

    if (settings.saveTarget === "daily") {
      new Setting(containerEl)
        .setName("今日日记目录")
        .setDesc("留空表示保存在仓库根目录。")
        .addText((text) =>
          text
            .setPlaceholder("例如：Daily")
            .setValue(settings.dailyFolder)
            .onChange(async (value) => {
              this.plugin.settings.quickNote.dailyFolder = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("今日日记文件名格式")
        .setDesc("支持 YYYY、MM、DD 变量，默认 YYYY-MM-DD。")
        .addText((text) =>
          text
            .setPlaceholder("YYYY-MM-DD")
            .setValue(settings.dailyFileNamePattern)
            .onChange(async (value) => {
              this.plugin.settings.quickNote.dailyFileNamePattern = value.trim() || "YYYY-MM-DD";
              await this.plugin.saveSettings();
            })
        );
    }

    if (settings.saveTarget === "new-file") {
      new Setting(containerEl)
        .setName("新建文件目录")
        .setDesc("例如：Inbox/QuickNotes")
        .addText((text) =>
          text
            .setPlaceholder("QuickNotes")
            .setValue(settings.newFileFolder)
            .onChange(async (value) => {
              this.plugin.settings.quickNote.newFileFolder = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("新建文件前缀")
        .setDesc("最终文件名示例：QuickNote-20260306-130000.md")
        .addText((text) =>
          text
            .setPlaceholder("QuickNote")
            .setValue(settings.newFileNamePrefix)
            .onChange(async (value) => {
              this.plugin.settings.quickNote.newFileNamePrefix = value.trim() || "QuickNote";
              await this.plugin.saveSettings();
            })
        );
    }
  }

  private scheduleOpenQuickNoteWindow(): void {
    if (!this.plugin.settings.quickNote.enabled) {
      new Notice("快捷记录功能未启用，请先在设置中开启。", 3500);
      return;
    }

    window.setTimeout(() => {
      void this.openQuickNoteWindow();
    }, 80);
  }

  private registerGlobalShortcut(): void {
    this.unregisterGlobalShortcut();

    const settings = this.plugin.settings.quickNote;
    if (!settings.enabled || !settings.useGlobalShortcut) {
      return;
    }

    const accelerator = settings.globalShortcut.trim();
    if (!accelerator) {
      return;
    }

    type ElectronModuleLike = {
      remote?: {
        globalShortcut?: {
          register: (accelerator: string, callback: () => void) => boolean;
          unregister: (accelerator: string) => void;
        };
      };
    };

    try {
      const unsafeWindow = window as Window & {
        require?: (id: string) => ElectronModuleLike;
      };
      const electronModule = unsafeWindow.require?.("electron");
      const globalShortcut = electronModule?.remote?.globalShortcut;
      if (!globalShortcut) {
        new Notice("当前环境不支持内置全局热键注册。", 4000);
        return;
      }

      const registered = globalShortcut.register(accelerator, () => {
        this.scheduleOpenQuickNoteWindow();
      });

      if (!registered) {
        new Notice(`全局热键注册失败：${accelerator}` , 5000);
        return;
      }

      this.registeredShortcut = accelerator;
    } catch {
      new Notice("内置全局热键注册失败，请检查 Electron 环境或热键冲突。", 5000);
    }
  }

  private unregisterGlobalShortcut(): void {
    if (!this.registeredShortcut) {
      return;
    }

    type ElectronModuleLike = {
      remote?: {
        globalShortcut?: {
          unregister: (accelerator: string) => void;
        };
      };
    };

    try {
      const unsafeWindow = window as Window & {
        require?: (id: string) => ElectronModuleLike;
      };
      const electronModule = unsafeWindow.require?.("electron");
      electronModule?.remote?.globalShortcut?.unregister(this.registeredShortcut);
    } catch {
      return;
    } finally {
      this.registeredShortcut = null;
    }
  }

  private async openQuickNoteWindow(): Promise<void> {
    if (this.captureSession) {
      try {
        await this.focusCaptureSession(this.captureSession);
        return;
      } catch {
        await this.closeCaptureSession({ closeLeaf: false });
      }
    }

    try {
      const file = await this.getOrCreateCaptureFile();
      const leaf = this.createPopoutLeaf();
      this.captureSession = {
        leaf,
        filePath: file.path,
        closeArmed: false
      };

      await leaf.openFile(file, { active: false });

      const popupWindow = await this.resolveWindowFromLeaf(leaf);
      if (popupWindow) {
        this.markWindowExempt(popupWindow, true);
        this.captureSession.popupWindow = popupWindow;
      }

      await this.focusCaptureSession(this.captureSession);

      await this.bindSaveHotkeyForSession(this.captureSession);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      new Notice(`无法打开快捷记录窗口：${message}`, 6000);
    }
  }

  private createPopoutLeaf(): WorkspaceLeaf {
    try {
      const popoutLeaf = this.plugin.app.workspace.openPopoutLeaf({
        size: {
          width: 700,
          height: 300
        }
      });
      if (!popoutLeaf) {
        throw new Error("openPopoutLeaf 返回空 leaf");
      }
      return popoutLeaf;
    } catch {
      const fallbackLeaf = this.plugin.app.workspace.getLeaf("window");
      if (!fallbackLeaf) {
        throw new Error("getLeaf('window') 返回空 leaf");
      }
      return fallbackLeaf;
    }
  }

  private async getOrCreateCaptureFile(): Promise<TFile> {
    if (this.plugin.settings.quickNote.saveTarget === "daily") {
      return this.getOrCreateDailyCaptureFile();
    }
    return this.createNewCaptureFile();
  }

  private async getOrCreateDailyCaptureFile(): Promise<TFile> {
    const settings = this.plugin.settings.quickNote;
    const folder = settings.dailyFolder.trim();
    const dateName = this.formatDateByPattern(new Date(), settings.dailyFileNamePattern);
    const filePath = normalizePath(folder ? `${folder}/${dateName}.md` : `${dateName}.md`);

    await this.ensureFolderExists(folder);
    return this.getOrCreateFile(filePath);
  }

  private async createNewCaptureFile(): Promise<TFile> {
    const settings = this.plugin.settings.quickNote;
    const folder = settings.newFileFolder.trim();
    await this.ensureFolderExists(folder);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const now = new Date();
      const stamp = this.formatDateByPattern(now, "YYYYMMDD-HHmmss");
      const prefix = settings.newFileNamePrefix.trim() || "QuickNote";
      const suffix = attempt === 0 ? "" : `-${Math.random().toString(36).slice(2, 6)}`;
      const filePath = normalizePath(
        folder ? `${folder}/${prefix}-${stamp}${suffix}.md` : `${prefix}-${stamp}${suffix}.md`
      );

      if (this.plugin.app.vault.getAbstractFileByPath(filePath)) {
        continue;
      }

      return this.plugin.app.vault.create(filePath, "");
    }

    throw new Error("无法创建新记录文件，请稍后重试");
  }

  private async bindSaveHotkeyForSession(session: CaptureSession): Promise<void> {
    const win = await this.resolveWindowFromLeaf(session.leaf);
    if (!win) {
      return;
    }

    const onKeydown = (event: KeyboardEvent): void => {
      const isSave = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s";
      if (!isSave) {
        return;
      }

      const current = this.captureSession;
      if (!current || current !== session) {
        return;
      }

      current.closeArmed = true;
    };

    win.addEventListener("keydown", onKeydown, true);
    session.unbindSaveHotkey = () => {
      win.removeEventListener("keydown", onKeydown, true);
    };
  }

  private async resolveWindowFromLeaf(leaf: WorkspaceLeaf): Promise<Window | null> {
    for (let i = 0; i < 10; i += 1) {
      const view = (leaf as unknown as { view?: { containerEl?: HTMLElement } }).view;
      const windowObj = view?.containerEl?.ownerDocument?.defaultView ?? null;
      if (windowObj) {
        return windowObj;
      }
      await this.delay(50);
    }
    return null;
  }

  private async focusCaptureSession(session: CaptureSession): Promise<void> {
    const win = session.popupWindow ?? (await this.resolveWindowFromLeaf(session.leaf));
    if (win) {
      session.popupWindow = win;
      await this.focusPopupWindow(win);
      return;
    }
  }

  private async focusPopupWindow(win: Window): Promise<void> {
    for (let i = 0; i < 24; i += 1) {
      try {
        win.focus();
        this.focusNativeWindow(win);
      } catch {
        return;
      }

      await this.focusEditorInWindow(win);

      if (win.document.hasFocus()) {
        return;
      }

      await this.delay(50);
    }

    this.scheduleDeferredPopupFocus(win);
  }

  private focusNativeWindow(win: Window): void {
    const unsafeWin = win as Window & {
      require?: (id: string) => {
        remote?: { getCurrentWindow?: () => { focus: () => void } };
      };
    };

    try {
      const electronModule = unsafeWin.require?.("electron");
      electronModule?.remote?.getCurrentWindow?.()?.focus();
    } catch {
      return;
    }
  }

  private scheduleDeferredPopupFocus(win: Window): void {
    const delays = [80, 160, 320, 640];
    for (const delayMs of delays) {
      win.setTimeout(() => {
        this.focusNativeWindow(win);
        void this.focusEditorInWindow(win);
      }, delayMs);
    }
  }

  private async focusEditorInWindow(win: Window): Promise<void> {
    for (let i = 0; i < 12; i += 1) {
      const doc = win.document;
      const editorTarget =
        (doc.querySelector(".cm-content") as HTMLElement | null) ??
        (doc.querySelector(".markdown-source-view .cm-editor") as HTMLElement | null) ??
        (doc.querySelector("textarea") as HTMLTextAreaElement | null);

      if (editorTarget) {
        editorTarget.focus();

        const selection = win.getSelection();
        if (selection && editorTarget.firstChild) {
          selection.selectAllChildren(editorTarget);
          selection.collapseToEnd();
        }

        await this.delay(20);
        return;
      }

      await this.delay(40);
    }
  }

  private async handleTempFileModify(file: TAbstractFile): Promise<void> {
    const session = this.captureSession;
    if (!session || !(file instanceof TFile) || file.path !== session.filePath) {
      return;
    }

    if (!session.closeArmed) {
      return;
    }

    session.closeArmed = false;
    await this.closeCaptureSession({ closeLeaf: true });
  }

  private async cleanupOrphanSession(): Promise<void> {
    const session = this.captureSession;
    if (!session) {
      return;
    }

    let exists = false;
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf === session.leaf) {
        exists = true;
      }
    });

    if (!exists) {
      await this.closeCaptureSession({ closeLeaf: false });
    }
  }

  private async closeCaptureSession(options: CloseSessionOptions): Promise<void> {
    const session = this.captureSession;
    if (!session) {
      return;
    }

    this.captureSession = null;
    if (session.unbindSaveHotkey) {
      session.unbindSaveHotkey();
    }

    if (session.popupWindow) {
      this.markWindowExempt(session.popupWindow, false);
    }

    if (options.closeLeaf) {
      const removeObserverWarningSuppression = session.popupWindow
        ? this.suppressResizeObserverWarning(session.popupWindow)
        : null;

      await this.delay(120);
      try {
        session.popupWindow?.document.activeElement instanceof HTMLElement &&
          session.popupWindow.document.activeElement.blur();
        session.leaf.detach();
      } catch {
        removeObserverWarningSuppression?.();
        return;
      }

      window.setTimeout(() => {
        removeObserverWarningSuppression?.();
      }, 600);
    }
  }

  private markWindowExempt(win: Window, enabled: boolean): void {
    const rawWin = win as Window & { __LOCK_SCREEN_EXEMPT__?: boolean };
    rawWin.__LOCK_SCREEN_EXEMPT__ = enabled;

    if (enabled) {
      win.document.documentElement.setAttribute("data-lockscreen-exempt", "true");
      if (win.document.body) {
        win.document.body.setAttribute("data-lockscreen-exempt", "true");
      }
    } else {
      win.document.documentElement.removeAttribute("data-lockscreen-exempt");
      if (win.document.body) {
        win.document.body.removeAttribute("data-lockscreen-exempt");
      }
    }
  }

  private suppressResizeObserverWarning(win: Window): () => void {
    const handler = (event: ErrorEvent): void => {
      if (!event.message.includes("ResizeObserver loop completed with undelivered notifications")) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
    };

    win.addEventListener("error", handler);
    return () => {
      win.removeEventListener("error", handler);
    };
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      window.setTimeout(() => resolve(), ms);
    });
  }

  private async ensureFolderExists(folderPath: string): Promise<void> {
    if (!folderPath.trim()) {
      return;
    }

    const normalized = normalizePath(folderPath);
    const segments = normalized.split("/").filter(Boolean);

    let currentPath = "";
    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = this.plugin.app.vault.getAbstractFileByPath(currentPath);
      if (existing instanceof TFile) {
        throw new Error(`路径冲突：${currentPath} 已是文件，无法创建目录`);
      }
      if (existing instanceof TFolder) {
        continue;
      }

      try {
        await this.plugin.app.vault.createFolder(currentPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("folder already exists")) {
          throw error;
        }
      }
    }
  }

  private async getOrCreateFile(path: string): Promise<TFile> {
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      return existing;
    }
    return this.plugin.app.vault.create(path, "");
  }

  private formatDateByPattern(date: Date, pattern: string): string {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");

    return pattern
      .replace(/YYYY/g, year)
      .replace(/MM/g, month)
      .replace(/DD/g, day)
      .replace(/HH/g, hours)
      .replace(/mm/g, minutes)
      .replace(/ss/g, seconds);
  }
}
