import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { DbusLockSignalParser, SystemLockDetector } from "../src/systemLockDetector";

class FakeStream extends EventEmitter {
  encoding = "";

  setEncoding(encoding: string): void {
    this.encoding = encoding;
  }
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new FakeStream();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

test("识别 KDE AboutToLock 信号", () => {
  let lockCount = 0;
  const parser = new DbusLockSignalParser(() => {
    lockCount += 1;
  });

  parser.push(
    "signal time=1 sender=:1.1 -> destination=(null destination) serial=1 path=/ScreenSaver; interface=org.kde.screensaver; member=AboutToLock\n"
  );

  assert.equal(lockCount, 1);
});

test("跨数据块识别 ActiveChanged(true) 并忽略 false", () => {
  let lockCount = 0;
  const parser = new DbusLockSignalParser(() => {
    lockCount += 1;
  });

  parser.push(
    "signal time=1 path=/ScreenSaver; interface=org.freedesktop.ScreenSaver; member=ActiveChanged\n   bool"
  );
  parser.push("ean false\n");
  parser.push(
    "signal time=2 path=/ScreenSaver; interface=org.freedesktop.ScreenSaver; member=ActiveChanged\n   boolean tr"
  );
  parser.push("ue\n");

  assert.equal(lockCount, 1);
});

test("Linux 同时监听 Electron 与固定 DBus 信号", () => {
  const powerMonitor = new EventEmitter();
  const child = new FakeChildProcess();
  const spawnCalls: unknown[][] = [];
  let lockCount = 0;

  const detector = new SystemLockDetector({
    platform: "linux",
    requireModule: (id) => {
      if (id === "electron") {
        return { powerMonitor };
      }
      if (id === "child_process") {
        return {
          spawn: (...args: unknown[]) => {
            spawnCalls.push(args);
            return child;
          }
        };
      }
      return undefined;
    },
    onLock: () => {
      lockCount += 1;
    },
    onUnavailable: () => assert.fail("检测通道不应不可用"),
    onWarning: () => assert.fail("监听不应产生警告")
  });

  detector.start();
  powerMonitor.emit("lock-screen");
  child.stdout.emit(
    "data",
    "signal time=1 path=/ScreenSaver; interface=org.kde.screensaver; member=AboutToLock\n"
  );

  assert.equal(lockCount, 2);
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0][0], "dbus-monitor");
  assert.deepEqual((spawnCalls[0][1] as string[]).slice(0, 1), ["--session"]);
  assert.match((spawnCalls[0][1] as string[])[1], /org\.kde\.screensaver/);
  assert.match((spawnCalls[0][1] as string[])[2], /org\.freedesktop\.ScreenSaver/);
  assert.equal(child.stdout.encoding, "utf8");
});

test("非 Linux 平台不启动 DBus 监听", () => {
  const powerMonitor = new EventEmitter();
  let requestedChildProcess = false;

  const detector = new SystemLockDetector({
    platform: "darwin",
    requireModule: (id) => {
      if (id === "electron") {
        return { powerMonitor };
      }
      requestedChildProcess = true;
      return undefined;
    },
    onLock: () => undefined,
    onUnavailable: () => assert.fail("Electron 通道可用"),
    onWarning: () => assert.fail("不应产生警告")
  });

  detector.start();

  assert.equal(requestedChildProcess, false);
});

test("所有通道不可用时只通知一次", () => {
  let unavailableCount = 0;
  const warnings: string[] = [];
  const detector = new SystemLockDetector({
    platform: "linux",
    requireModule: () => {
      throw new Error("模块不可用");
    },
    onLock: () => undefined,
    onUnavailable: () => {
      unavailableCount += 1;
    },
    onWarning: (message) => warnings.push(message)
  });

  detector.start();
  detector.start();

  assert.equal(unavailableCount, 1);
  assert.equal(warnings.length, 2);
});

test("DBus 异常退出且无 Electron 通道时报告不可用", () => {
  const child = new FakeChildProcess();
  let unavailableCount = 0;
  const warnings: string[] = [];
  const detector = new SystemLockDetector({
    platform: "linux",
    requireModule: (id) => {
      if (id === "child_process") {
        return { spawn: () => child };
      }
      return undefined;
    },
    onLock: () => undefined,
    onUnavailable: () => {
      unavailableCount += 1;
    },
    onWarning: (message) => warnings.push(message)
  });

  detector.start();
  child.emit("error", new Error("启动失败"));
  child.emit("exit", 1, null);

  assert.equal(unavailableCount, 1);
  assert.equal(warnings.length, 1);
});

test("停止监听时移除事件并终止 DBus 子进程", () => {
  const powerMonitor = new EventEmitter();
  const child = new FakeChildProcess();
  let lockCount = 0;
  const detector = new SystemLockDetector({
    platform: "linux",
    requireModule: (id) => {
      if (id === "electron") {
        return { remote: { powerMonitor } };
      }
      return { spawn: () => child };
    },
    onLock: () => {
      lockCount += 1;
    },
    onUnavailable: () => undefined,
    onWarning: () => undefined
  });

  detector.start();
  detector.stop();
  powerMonitor.emit("lock-screen");
  child.stdout.emit(
    "data",
    "signal time=1 path=/ScreenSaver; interface=org.kde.screensaver; member=AboutToLock\n"
  );

  assert.equal(child.killed, true);
  assert.equal(powerMonitor.listenerCount("lock-screen"), 0);
  assert.equal(child.stdout.listenerCount("data"), 0);
  assert.equal(lockCount, 0);
});
