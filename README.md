# LockScreen

LockScreen 是一个面向 Obsidian 桌面端的访问授权码锁屏插件。

## 项目介绍
- 核心能力聚焦为两部分：访问授权码锁屏、快捷记录弹窗。
- 锁屏功能在桌面端系统锁屏后自动保护工作区，使用完全不透明遮罩并支持多窗口联动解锁。
- 授权码界面会跟随 Obsidian 当前浅色/深色主题，输入正确授权码后恢复访问。
- 快捷记录功能提供独立弹窗，默认尺寸 `700x300`，打开后自动聚焦编辑区，可直接输入并用 `Ctrl+S` 保存关闭。
- 快捷记录弹窗默认加入锁屏豁免，不影响主窗口、副窗口的锁屏状态。
- 支持插件内置 Electron 全局热键，可直接唤起快捷记录弹窗。
- 已配置 GitHub Action 与 Gitea Action：仅在版本号变化时自动构建并发布 Release（含 zip 附件）。
- 代理协作规范与工程约束见 `AGENTS.md`。

## 文档说明
- 模块/功能设计文档目录：`docs/`
- 设计文档导航索引：`docs/README.md`

## 开发命令
- 安装依赖：`npm install`
- 开发构建（watch）：`npm run dev`
- 生产构建：`npm run build`
- 类型检查：`npm run typecheck`
