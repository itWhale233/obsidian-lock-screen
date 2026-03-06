# CI/CD 自动发布设计

## 目标
- 在推送到 `master` 后自动执行构建。
- 将构建产物作为 Release 附件发布。
- 同时支持 GitHub 与 Gitea 两种托管环境。

## 工作流文件
- GitHub：`.github/workflows/release.yml`
- Gitea：`.gitea/workflows/release.yml`

## 触发条件
- 触发事件：`push`
- 触发分支：`master`

## 构建流程
1. 检出代码。
2. 安装 Node.js 20。
3. 执行 `npm ci`。
4. 执行 `npm run build`。
5. 创建 Release 并上传构建产物。

## 发布产物
- `main.js`
- `manifest.json`
- `styles.css`
- `versions.json`

## GitHub Action 说明
- 使用 `softprops/action-gh-release@v2` 创建 Release。
- 每次运行生成标签：`auto-build-<run_number>`。
- 使用仓库内置 `GITHUB_TOKEN` 完成发布。

## Gitea Action 说明
- 使用 Gitea REST API 创建 Release。
- 每次运行生成标签：`auto-build-<run_number>`。
- 通过 `curl` 上传 Release 附件。
- 需要在仓库 Secrets 中配置 `GITEA_TOKEN`。

## 注意事项
- 若同一个 `run_number` 标签已存在，发布会失败。
- 若 Gitea 未配置 `GITEA_TOKEN`，工作流会直接失败并提示。
- 若后续新增构建文件，需同步更新两个工作流的附件列表。
