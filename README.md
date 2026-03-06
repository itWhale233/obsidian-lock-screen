# LockScreen

LockScreen 是一个面向 Obsidian 桌面端的访问授权码锁屏插件。

## 项目介绍
- 插件为 Obsidian 桌面端提供“访问授权码”保护能力。
- 当操作系统进入锁屏状态后，可自动锁定工作区。
- 锁定状态使用完全不透明遮罩，确保笔记内容不可见。
- 锁定时保留系统窗口控制区域，可最小化、还原与关闭窗口。
- 多窗口状态联动：任一窗口锁定后新开窗口也会锁定；任一窗口解锁后所有窗口同步解锁。
- 用户需输入正确授权码后才能继续查看与编辑内容。
- 已配置 GitHub Action 与 Gitea Action：提交到 `master` 且版本号变化时自动构建并发布 Release（含 zip 打包附件）。
- 代理协作规范与工程约束见 `AGENTS.md`。

## 文档说明
- 模块/功能设计文档目录：`docs/`
- 设计文档导航索引：`docs/README.md`

## 开发命令
- 安装依赖：`npm install`
- 开发构建（watch）：`npm run dev`
- 生产构建：`npm run build`
- 类型检查：`npm run typecheck`
