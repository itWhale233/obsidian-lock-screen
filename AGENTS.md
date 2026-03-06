# AGENTS.md
面向在本仓库中运行的智能编码代理的工作指南。

## 当前仓库状态
- 当前仓库根目录已初始化为 Obsidian 插件项目。
- 关键文件包含：`package.json`、`manifest.json`、`src/`、`docs/`、`README.md`。
- 当前未发现 Cursor 规则文件（`.cursor/rules/`、`.cursorrules`）。
- 当前未发现 Copilot 规则文件（`.github/copilot-instructions.md`）。

## 代理优先级
1. 优先遵循仓库内真实配置（scripts、lint、test、CI、formatter）。
2. 变更保持最小化、聚焦任务目标。
3. 未经明确要求，不执行破坏性操作。
4. 优先执行与改动直接相关的定向验证。
5. 反馈中必须说明：执行了什么、通过了什么、失败了什么、跳过了什么。

## 文档与语言要求（强制）
- 每次对话结束后，必须将**实际涉及**的模块/功能设计同步到 `docs/`。
- 设计文档按模块拆分，使用 `docs/<module>.md` 形式维护。
- `docs/README.md` 必须作为文档导航索引，新增/调整文档时同步更新。
- 若改动影响项目范围、能力边界或架构行为，必须同步更新根目录 `README.md` 的项目介绍。
- 文档更新是功能类与设计影响类任务的完成条件之一。
- **文档内容必须使用中文编写**（包括 `README.md`、`docs/*.md`、`AGENTS.md`）。
- **代码注释必须使用中文**；仅在必要时添加注释，避免无价值注释。
- 面向用户的提示文案默认使用中文；若需英文，需在变更说明中注明原因。

## 编码前先发现真实命令
优先检查：
- `package.json` scripts
- 锁文件：`pnpm-lock.yaml`、`package-lock.json`、`yarn.lock`、`bun.lockb`
- 测试配置：`vitest.config.*`、`jest.config.*`、`playwright.config.*`
- Lint/格式化配置：`eslint*`、`.prettierrc*`、`biome.json`
- TS 配置：`tsconfig*.json`
- CI 工作流：`.github/workflows/*.yml`

若本文件与仓库真实配置冲突，以仓库配置为准。

## 构建、检查、测试命令
依据锁文件选择包管理器；若无锁文件，默认 `npm`。

### 安装依赖
- `npm install`
- `pnpm install`
- `yarn install`
- `bun install`

### 构建
- `npm run build`
- `pnpm build`
- `yarn build`
- `bun run build`

### Lint
- `npm run lint`
- `pnpm lint`
- `yarn lint`
- `bun run lint`

### Typecheck
- `npm run typecheck`
- `pnpm typecheck`
- `yarn typecheck`
- `bun run typecheck`

### 全量测试
- `npm test`
- `pnpm test`
- `yarn test`
- `bun test`

### 单测/单文件测试（优先）
优先使用 script 透传：
- `npm test -- <file-or-pattern>`
- `pnpm test -- <file-or-pattern>`
- `yarn test <file-or-pattern>`
- `bun test <file-or-pattern>`

框架特定示例（必要时）：
- Vitest 文件：`npx vitest run path/to/file.test.ts`
- Vitest 用例名：`npx vitest run -t "test name"`
- Jest 文件：`npx jest path/to/file.test.ts`
- Jest 用例名：`npx jest -t "test name"`
- Playwright 规格：`npx playwright test tests/example.spec.ts`
- Playwright 名称：`npx playwright test -g "test title"`

若仓库存在专用脚本（如 `test:unit`），优先使用专用脚本。

## 推荐验证顺序
代码改动建议按顺序执行：
1. 与改动行为对应的定向测试。
2. Lint（先局部，必要时全量）。
3. Typecheck。
4. 全量测试（可行时）。
5. 生产构建（发布关键改动时）。

仅文档改动通常可跳过测试，除非 CI 对文档有校验。

## 代码风格基线
在仓库未提供更细规则前，遵循以下约定。

### 通用
- 可读性优先于技巧性。
- 函数保持单一职责、体量适中。
- 命名语义明确，避免晦涩缩写。
- 非必要不做与任务无关的重构。
- 改行为必须显式说明意图与影响。

### 导入
- 分组顺序：内置、第三方、内部模块、相对路径。
- 组内尽量保持稳定排序。
- 优先命名导入，避免通配符导入。
- 删除未使用导入。

### 格式化
- 有格式化工具时遵循工具默认配置。
- TS/JS 默认 2 空格缩进。
- 长表达式主动换行，保持可读性。
- 避免在未改动文件引入格式化噪音。

### 类型（TypeScript）
- 对外 API 优先显式类型。
- 局部变量按可读性选择推断或标注。
- 避免 `any`，优先 `unknown` + 缩窄。
- 领域数据使用 `type`/`interface` 建模。
- 明确处理 `null`/`undefined` 分支。

### 命名
- `PascalCase`：组件、类、接口、类型。
- `camelCase`：变量、函数、方法。
- `UPPER_SNAKE_CASE`：常量与环境变量键。
- 文件命名遵循当前仓库既有约定并保持一致。
- 测试名称描述行为，不描述实现细节。

### 错误处理
- 快速失败并给出可执行的错误信息。
- 不要静默吞错。
- 重抛时补充上下文（支持时使用 `cause`）。
- 在系统边界校验外部输入。

### 日志
- 日志应简洁、结构化、无敏感信息。
- 禁止输出密钥、令牌、凭据。
- 正确使用 warning/error 级别。

### 测试
- 行为变化必须补充或更新测试。
- 测试要可重复、可隔离。
- 仅 mock 真实外部边界（网络、文件系统、时间）。
- 断言以行为结果为主，避免强耦合实现细节。

## Cursor 与 Copilot 规则
当前未发现以下文件：
- `.cursor/rules/`
- `.cursorrules`
- `.github/copilot-instructions.md`

若后续新增上述文件，代理必须优先读取并遵循其规则。

## 维护说明
当仓库引入新的脚本、工具链或工程规范时，请及时更新本文件。
