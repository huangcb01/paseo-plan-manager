# 项目协作指南

## 项目概况

本项目是 Paseo Coding Plan Manager 本地插件，管理 Codex / ChatGPT、智谱 GLM 和 Kimi 的账号凭据与用量，并将所选 Plan 配置到 OpenCode、Codex、Claude Code 或 Oh My Pi。

- 开发前阅读 `README.md` 中与任务相关的功能、配置投影和数据约定。
- 默认使用中文交流和维护说明文档；代码标识符沿用现有英文命名。
- 运行环境为 Node.js >= 20，使用 npm 和 `package-lock.json`；Paseo SDK 版本以 `package.json` 为准。
- 这是由 Paseo 加载的插件，当前没有独立的开发服务器、构建或 lint 脚本。

## 代码导航与边界

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 注册 RPC、Workspace Panel 和命令入口 |
| `main.client.tsx` | React Native 管理界面、React Query 数据获取和表单草稿 |
| `plans.shared.ts` | Zod schema、共享类型和 RPC 契约 |
| `model-capabilities.shared.ts` | 模型能力、参数校验和目标工具支持的字段 |
| `handlers.server.ts` | RPC handler，连接存储、用量和配置逻辑 |
| `store.server.ts` | Plan 元数据、私有凭据、数据迁移、Active 状态与缓存存储 |
| `usage.server.ts` | 用量请求、代理选择、响应归一化和历史记录 |
| `config.server.ts` | 目标工具路径解析、配置 patch 和实际应用 |
| `file-utils.server.ts` | 文件大小限制、权限、快照、原子写入和恢复 |
| `tests/*.test.ts` | 使用 `node:test` 和 `node:assert/strict` 的测试 |

- 保持 `.client` / `.server` / `.shared` 分层；客户端不导入服务端文件或 Node 文件系统、凭据处理逻辑。
- 变更 RPC 数据时同步修改 schema、handler 和调用方；沿用 Zod 校验及推导类型。
- UI 沿用 React Native 组件、`StyleSheet` 和现有 RPC / React Query 模式。
- 遵循现有 TypeScript strict、双引号、分号和两空格缩进风格，避免无关的大范围重排。

## 需要保持的业务约定

- Plan 保存账号信息和凭据；目标模型列表及能力参数属于本次应用草稿，不保存回 Plan。模型列表最多 16 个，首个为默认模型。
- OpenCode 和 Oh My Pi 的 Active 状态按 provider 分槽；Codex 和 Claude Code 各自为单例。实际应用成功后才更新对应状态。
- 区分 Token 活动与配额百分比；用量未知时不伪造为 0，刷新失败时保留可用缓存并标记过期。
- 修改持久化 schema 时保留旧版本迁移路径，并覆盖相关迁移行为。
- 新增或修改供应商、目标工具支持时，同步检查共享校验、界面选项、服务端配置和 README 支持矩阵。接口、模型能力和配置格式应依据对应工具的官方文档或源码核实。

## 凭据与配置写入

- 明文 API Key、OAuth token 和完整 auth JSON 只进入服务端私有凭据存储；保存后的 dashboard、Plan 元数据和 RPC 响应不返回明文凭据。
- 日志、错误信息、测试快照和提交内容不得包含真实凭据、Authorization header 或含凭据的响应正文；测试使用构造数据。
- 保持私有目录 `0700`、凭据文件 `0600` 的 Unix 权限，以及现有文件大小限制和符号链接保护。
- 配置修改复用现有 patch、快照和原子写入工具；保留无关配置、用户自定义内容及 JSONC / YAML 注释。多文件写入保留失败回滚，不声称具有跨文件原子性。
- 仅清理能够确认由插件管理的配置。无法安全解析或修改的配置应明确失败，不覆盖为默认文件。
- 保持 OAuth 身份与 token generation 校验，不将 ChatGPT workspace Account ID 当作登录身份；不要自行兑换旋转 refresh token。
- 保持用量请求的精确 HTTPS hostname 白名单、重定向限制、响应体限制和超时。代理选择遵循 Plan 开关与现有环境变量规则。
- 不支持的协议或凭据存储模式应明确返回未写入；Oh My Pi OAuth 导入沿用官方 `omp auth-broker import`，不直接修改其 SQLite 凭据库。

## 开发与验证

```bash
npm ci                 # 首次准备依赖，按 lockfile 安装
npm run typecheck      # TypeScript 检查
npm test               # 全部测试
npm run check          # 类型检查 + 全部测试
npx --no-install tsx --test tests/config.test.ts  # 示例：针对配置逻辑验证
```

- 代码变更完成后运行 `npm run check`；仅文档变更可检查内容和 `git diff --check`，无需安装依赖或运行代码测试。
- 修复行为缺陷时，在对应测试文件补充能复现问题的回归用例。配置与存储变更重点验证保留用户字段、失败回滚、迁移和凭据隔离。
- 文件写入测试使用 `mkdtemp` 临时目录和独立 `PlanStore`，结束后清理；修改测试环境变量时保存并恢复原值，不写入真实用户配置。
- 用量解析使用固定样例；网络测试使用本地服务或替身。代理测试需要绑定本机回环端口，若环境限制导致失败，应说明限制。
- 不为测试安装目标 CLI 或调用真实账号接口；类型检查和格式级测试通过不能等同于目标 CLI 的真实请求验证。
- 需要在已安装的 Paseo 中手动验证时，检查通过后可执行 `paseo plugin reload coding-plan-manager`，并在 Workspace 右侧栏打开 Coding Plans。
- 用户可见行为、配置路径或兼容性变化同步更新 `README.md`；交付时说明改动、实际执行的验证及未验证部分。
