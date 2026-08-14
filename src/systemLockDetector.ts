const KDE_ABOUT_TO_LOCK_RULE =
  "type='signal',path='/ScreenSaver',interface='org.kde.screensaver',member='AboutToLock'";
const FREEDESKTOP_ACTIVE_CHANGED_RULE =
  "type='signal',path='/ScreenSaver',interface='org.freedesktop.ScreenSaver',member='ActiveChanged'";

interface EventEmitterLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface PowerMonitorLike extends EventEmitterLike {}

interface ReadableStreamLike extends EventEmitterLike {
  setEncoding?(encoding: string): unknown;
}

interface ChildProcessLike extends EventEmitterLike {
  stdout: ReadableStreamLike;
  kill(): boolean;
}

interface ChildProcessModuleLike {
  spawn(
    command: string,
    args: string[],
    options: { stdio: ["ignore", "pipe", "ignore"]; windowsHide: boolean }
  ): ChildProcessLike;
}

interface ElectronModuleLike {
  powerMonitor?: PowerMonitorLike;
  remote?: {
    powerMonitor?: PowerMonitorLike;
  };
}

export interface SystemLockDetectorOptions {
  platform: string;
  requireModule?: (id: string) => unknown;
  onLock: () => void;
  onUnavailable: () => void;
  onWarning: (message: string, error?: unknown) => void;
}

export class DbusLockSignalParser {
  private buffer = "";
  private awaitingActiveChangedValue = false;

  constructor(private readonly onLock: () => void) {}

  push(chunk: string): void {
    this.buffer += chunk;

    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.processLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private processLine(line: string): void {
    if (line.startsWith("signal ")) {
      const isAboutToLock =
        line.includes("interface=org.kde.screensaver") && line.includes("member=AboutToLock");
      const isActiveChanged =
        line.includes("interface=org.freedesktop.ScreenSaver") &&
        line.includes("member=ActiveChanged");

      this.awaitingActiveChangedValue = isActiveChanged;
      if (isAboutToLock) {
        this.onLock();
      }
      return;
    }

    if (!this.awaitingActiveChangedValue) {
      return;
    }

    if (line === "boolean true") {
      this.awaitingActiveChangedValue = false;
      this.onLock();
      return;
    }

    if (line === "boolean false") {
      this.awaitingActiveChangedValue = false;
    }
  }
}

export class SystemLockDetector {
  private powerMonitor: PowerMonitorLike | null = null;
  private dbusProcess: ChildProcessLike | null = null;
  private electronAvailable = false;
  private dbusAvailable = false;
  private dbusFailed = false;
  private started = false;
  private stopped = false;
  private unavailableNotified = false;

  private readonly handleElectronLock = (): void => {
    if (!this.stopped) {
      this.options.onLock();
    }
  };

  private readonly handleDbusData = (...args: unknown[]): void => {
    if (this.stopped) {
      return;
    }

    const chunk = args[0];
    this.dbusParser.push(typeof chunk === "string" ? chunk : String(chunk ?? ""));
  };

  private readonly handleDbusError = (...args: unknown[]): void => {
    this.handleDbusFailure("Linux DBus 锁屏监听启动失败。", args[0]);
  };

  private readonly handleDbusExit = (...args: unknown[]): void => {
    const code = args[0];
    this.handleDbusFailure(`Linux DBus 锁屏监听已退出，退出码：${String(code ?? "未知")}。`);
  };

  private readonly dbusParser = new DbusLockSignalParser(() => {
    if (!this.stopped) {
      this.options.onLock();
    }
  });

  constructor(private readonly options: SystemLockDetectorOptions) {}

  start(): void {
    if (this.started || this.stopped) {
      return;
    }

    this.started = true;
    this.startElectronMonitor();
    if (this.options.platform === "linux") {
      this.startLinuxDbusMonitor();
    }

    this.notifyIfUnavailable();
  }

  stop(): void {
    if (this.stopped) {
      return;
    }

    this.stopped = true;

    this.powerMonitor?.removeListener("lock-screen", this.handleElectronLock);
    this.powerMonitor = null;
    this.electronAvailable = false;

    if (this.dbusProcess) {
      this.dbusProcess.stdout.removeListener("data", this.handleDbusData);
      this.dbusProcess.removeListener("error", this.handleDbusError);
      this.dbusProcess.removeListener("exit", this.handleDbusExit);
      this.dbusProcess.kill();
      this.dbusProcess = null;
    }
    this.dbusAvailable = false;
  }

  private startElectronMonitor(): void {
    try {
      const electronModule = this.options.requireModule?.("electron") as ElectronModuleLike | undefined;
      const powerMonitor = electronModule?.powerMonitor ?? electronModule?.remote?.powerMonitor;
      if (!powerMonitor) {
        return;
      }

      powerMonitor.on("lock-screen", this.handleElectronLock);
      this.powerMonitor = powerMonitor;
      this.electronAvailable = true;
    } catch (error) {
      this.options.onWarning("Electron 系统锁屏监听启动失败。", error);
    }
  }

  private startLinuxDbusMonitor(): void {
    try {
      const childProcessModule = this.options.requireModule?.("child_process") as
        | ChildProcessModuleLike
        | undefined;
      if (!childProcessModule?.spawn) {
        this.options.onWarning("当前运行环境无法启动 Linux DBus 锁屏监听。");
        return;
      }

      const child = childProcessModule.spawn(
        "dbus-monitor",
        ["--session", KDE_ABOUT_TO_LOCK_RULE, FREEDESKTOP_ACTIVE_CHANGED_RULE],
        {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true
        }
      );

      child.stdout.setEncoding?.("utf8");
      child.stdout.on("data", this.handleDbusData);
      child.on("error", this.handleDbusError);
      child.on("exit", this.handleDbusExit);
      this.dbusProcess = child;
      this.dbusAvailable = true;
    } catch (error) {
      this.options.onWarning("Linux DBus 锁屏监听启动失败。", error);
    }
  }

  private handleDbusFailure(message: string, error?: unknown): void {
    if (this.stopped || this.dbusFailed) {
      return;
    }

    this.dbusFailed = true;
    this.dbusAvailable = false;
    this.options.onWarning(message, error);
    this.notifyIfUnavailable();
  }

  private notifyIfUnavailable(): void {
    if (this.electronAvailable || this.dbusAvailable || this.unavailableNotified || this.stopped) {
      return;
    }

    this.unavailableNotified = true;
    this.options.onUnavailable();
  }
}
