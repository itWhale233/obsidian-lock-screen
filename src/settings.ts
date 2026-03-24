import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type LockScreenPlugin from "./main";

export class LockScreenSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: LockScreenPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "锁屏插件" });

    new Setting(containerEl)
      .setName("启用访问授权码")
      .setDesc("启用后，必须输入正确授权码才能访问 Obsidian 工作区。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings();
          this.plugin.refreshLockState();
        })
      );

    new Setting(containerEl)
      .setName("系统锁屏时自动锁定")
      .setDesc("仅在操作系统进入锁屏状态后自动锁定，不受窗口切换影响。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.lockOnSystemLock).onChange(async (value) => {
          this.plugin.settings.lockOnSystemLock = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("启动时锁定")
      .setDesc("Obsidian 启动后立即进入锁定状态，需要输入授权码。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.lockOnStartup).onChange(async (value) => {
          this.plugin.settings.lockOnStartup = value;
          await this.plugin.saveSettings();
        })
      );

    let nextPasscode = "";

    new Setting(containerEl)
      .setName("设置访问授权码")
      .setDesc(
        this.plugin.hasConfiguredPasscode()
          ? "已配置授权码。保存后将覆盖当前授权码。"
          : "当前尚未配置授权码。"
      )
      .addText((text) => {
        text.inputEl.type = "password";
        text.setPlaceholder("至少 4 位字符");
        text.onChange((value) => {
          nextPasscode = value;
        });
      })
      .addButton((button) =>
        button.setButtonText("保存授权码").setCta().onClick(async () => {
          if (nextPasscode.length < 4) {
            new Notice("授权码长度至少为 4 位。");
            return;
          }

          await this.plugin.configurePasscode(nextPasscode);
          nextPasscode = "";
          new Notice("授权码已更新。");
          this.display();
        })
      )
      .addExtraButton((button) => {
        button.setIcon("cross");
        button.setTooltip("清除已配置授权码");
        button.onClick(async () => {
          const confirmed = window.confirm("确认清除当前访问授权码？");
          if (!confirmed) {
            return;
          }

          await this.plugin.clearPasscode();
          new Notice("授权码已清除。");
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("立即锁定")
      .setDesc("立刻锁定当前工作区，并要求输入授权码。")
      .addButton((button) =>
        button.setButtonText("立即锁定").onClick(() => {
          this.plugin.lockNow();
        })
      );

    containerEl.createEl("hr");
    this.plugin.renderQuickCaptureSettings(containerEl);
  }
}
