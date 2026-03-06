# CI/CD 自动发布设计

## 目标
- 在推送到 `master` 后自动执行构建。
- 仅在版本号变化时创建 Release。
- 将构建产物与 zip 打包文件作为 Release 附件发布。
- 同时支持 GitHub 与 Gitea 两种托管环境。

## 工作流文件
- GitHub：`.github/workflows/release.yml`
- Gitea：`.gitea/workflows/release.yml`

## 触发条件
- 触发事件：`push`
- 触发分支：`master`
- 发布门槛：`package.json` 的 `version` 对应标签（`v<version>`）不存在。

## 构建流程
1. 检出代码。
2. 安装 Node.js 20。
3. 读取 `package.json` 的版本号并生成发布标签 `v<version>`。
4. 若标签已存在，则跳过发布。
5. 若标签不存在，执行 `npm ci`。
6. 执行 `npm run build`。
7. 打包 `main.js`、`manifest.json`、`styles.css`、`versions.json` 为 zip。
8. 创建 Release 并上传构建产物与 zip。

## 发布产物
- `main.js`
- `manifest.json`
- `styles.css`
- `versions.json`
- `lock-screen-v<version>.zip`

## GitHub Action 说明
- 使用 `softprops/action-gh-release@v2` 创建 Release。
- 使用版本标签：`v<version>`。
- 使用仓库内置 `GITHUB_TOKEN` 完成发布。

## Gitea Action 说明
- 使用 Gitea REST API 创建 Release。
- 使用版本标签：`v<version>`。
- 通过 `curl` 上传 Release 附件。
- 需要在仓库 Secrets 中配置 `GITEA_TOKEN`。

## 注意事项
- 若 `v<version>` 标签已存在，工作流会跳过发布。
- 若 Gitea 未配置 `GITEA_TOKEN`，工作流会直接失败并提示。
- 若后续新增构建文件，需同步更新两个工作流的附件列表。
