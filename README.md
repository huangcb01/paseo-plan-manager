# Paseo Coding Plan Manager

一个本地 Paseo 插件，用于集中管理多个 Codex / ChatGPT、智谱 GLM Coding Plan 和 Kimi Coding Plan，查看额度与重置时间，并把指定 Plan 写入 OpenCode、Codex 或 Claude Code 的本机配置。

## 功能

- 同一 provider 可保存多个 Plan；每个 Plan 有独立名称、凭据和目标模型。
- Codex Plan 从 `auth.json` 导入，支持指定 `ChatGPT-Account-ID`。
- 智谱和 Kimi Plan 使用 API Key；保存后 daemon 不会把明文 Key 返回给客户端。
- 管理界面打开期间每 60 秒自动刷新，也可手动刷新。
- 展示 Codex 主/次/附加限额、智谱新 `CREDIT_LIMIT` 与旧 `TOKENS_LIMIT` 的 5 小时/周窗口及 MCP 限额、Kimi 周额度/全部限流窗口/并发上限。
- 一键覆盖 OpenCode 中对应 provider 当前 Plan，同时保留其他 provider 和 JSONC 注释。
- 一键写入 Codex `auth.json` / `config.toml`，或 Claude Code `settings.json` 与 `~/.claude.json` onboarding 状态。
- 检测 `opencode`、`codex`、`claude` 是否存在；插件不包含、下载或安装任何 CLI。

## Paseo 侧栏限制

需求中的精确位置是 Workspaces 列表下方、“添加 project”按钮上方。Paseo 0.5.x 在该位置有内部 `SidebarCallout`，但当前插件 API 没有暴露它；`addSidebarItem` 也不支持自定义组件、动态文本、badge 或排序位置。

因此本插件使用当前唯一受支持的实现：添加一个 **Coding Plans** 静态侧栏入口，点击后打开完整用量界面。Paseo 会把插件入口渲染在 Workspaces 上方。插件没有使用 DOM 注入或未公开内部模块，以免升级、移动端或暗色主题失效。

要实现精确位置，需要 Paseo 上游新增类似 `addSidebarWidget` 的 contribution API；仅修改本插件无法做到。

## 安装

要求 Paseo 0.5.x、Node.js 20 或更高版本。

```bash
npm install
npm run check
paseo plugin install /absolute/path/to/paseo-coding-plan-manager
```

在 Paseo 的 **Settings → Plugins** 中启用插件总开关。修改源码后执行：

```bash
npm run check
paseo plugin reload coding-plan-manager
```

也可通过 `Ctrl+K` / `Cmd+K` 搜索 **Open Coding Plans** 或 **Refresh Coding Plan usage**。

## 添加 Plan

### Codex / ChatGPT

默认读取 `$CODEX_HOME/auth.json`，未设置 `CODEX_HOME` 时读取 `~/.codex/auth.json`。导入时会复制凭据到插件的私有数据目录，原文件之后被移动也不会删除 Plan。

多个 Codex Plan 有两种方式：

- 为不同账号准备不同 `CODEX_HOME`，添加时分别填写其 `auth.json` 路径。
- 同一个 OAuth 身份有多个 ChatGPT workspace 时，多次导入同一个文件并填写不同 Account ID。

插件每次查询和切换前会检查来源 `auth.json`；只有 JWT 中的 OAuth 用户身份明确相同且来源 generation 更新时，才会同步较新的副本。写入 OpenCode/Codex 前还会比较目标文件：同身份目标 token 更新时先吸收目标 generation，generation 冲突或身份无法判断时拒绝覆盖。不同 ChatGPT workspace 的 Account ID 不会被误当成不同登录身份。插件不会擅自兑换旋转 refresh token，因为 Codex / OpenCode 同时刷新同一个 token 可能让另一个客户端失效。若副本已过期，请先用对应账号运行 Codex 刷新，再点“编辑 / 重新导入”。

### 智谱 GLM

支持三个固定区域：

- 中国区：`open.bigmodel.cn`
- Global / Z.AI：`api.z.ai`
- 中国区 Dev：`dev.bigmodel.cn`

用量查询只访问所选区域的 `/api/monitor/usage/quota/limit`，`Authorization` 使用原始 API Key，不添加 `Bearer`。

### Kimi Coding

用量查询访问 `https://api.kimi.com/coding/v1/usages`，使用 `Bearer` API Key 和 Kimi CLI User-Agent。

## 配置投影

| Plan | OpenCode | Codex | Claude Code |
| --- | --- | --- | --- |
| Codex OAuth | 支持，转换为 OpenCode `openai` OAuth 记录 | 支持，写入原生 Codex auth | 不直连；需要协议转换代理，插件会拒绝写入假配置 |
| 智谱 API Key | 支持 | 中国区和 Z.AI Global 支持原生 Responses；Dev 未验证 | 配置已实现，未经测试 |
| Kimi API Key | 支持 | 需要 Chat-to-Responses 代理，插件不写入 | 配置已实现，未经测试 |

### OpenCode

路径遵循 OpenCode 当前规则：

- 配置：`OPENCODE_CONFIG`，否则 `OPENCODE_CONFIG_DIR` / `$XDG_CONFIG_HOME/opencode` / `~/.config/opencode`。
- 凭据：`$XDG_DATA_HOME/opencode/auth.json`，否则 `~/.local/share/opencode/auth.json`。
- 已存在 `opencode.jsonc` 时优先修改它，否则使用 `opencode.json`。

插件只覆盖 `provider.kimi` 或 `provider.zhipu`、对应 auth 条目和顶层 `model`。其他 provider、插件、MCP、skills 及 JSONC 注释会保留。若设置了 `OPENCODE_CONFIG_CONTENT` 或 `OPENCODE_AUTH_CONTENT`，文件修改不会生效，因此插件会拒绝操作。

### Codex

路径为 `$CODEX_HOME` 或 `~/.codex` 下的 `auth.json` 和 `config.toml`。插件用结构化 TOML parser 在写入前后校验文件，保留其他 TOML 表，只更新根级模型选择和带有以下标记的 provider 块；无法安全修改的 quoted/特殊布局会拒绝写入，而不是生成重复键：

```toml
# BEGIN paseo-coding-plan-manager
# ...
# END paseo-coding-plan-manager
```

Codex 自定义 provider 要求 OpenAI Responses wire API。当前能力按供应商公开文档处理：

- Z.AI Global 使用 `https://api.z.ai/api/v1`，智谱中国区使用 `https://open.bigmodel.cn/api/v1`；两者都是官方 Responses 端点。插件写入独立模型目录、`experimental_bearer_token` 和 `wire_api = "responses"`，不覆盖 Codex OAuth `auth.json`。
- 智谱 Dev 尚无已验证的 Responses 端点；Kimi Coding 公开的是 Chat Completions 接口。二者需要类似 CC Switch 的本地双向协议转换代理，本插件当前不内置，因此按钮显示“需代理”，daemon 也会拒绝写入。

Codex OAuth 切换只支持 `cli_auth_credentials_store = "file"` 或未显式配置存储模式。若设置为 `keyring`、`auto` 或 `ephemeral`，插件不会修改系统钥匙串，也不会声称切换成功。

### Claude Code

路径为 `$CLAUDE_CONFIG_DIR/settings.json` 或 `~/.claude/settings.json`。插件仅修改 `env` 中的 provider URL、认证、模型和 context window，保留 permissions、hooks、plugins 及其他环境变量。它还合并对应 profile 的 onboarding 状态：默认是 `~/.claude.json`；设置 `CLAUDE_CONFIG_DIR` 时使用该目录内已有的 `.config.json`，否则使用 `.claude.json`。Kimi 额外设置官方要求的 `penguinModeOrgEnabled`。Kimi 使用 `ANTHROPIC_API_KEY`，并同时设置 Fable、Haiku、Sonnet、Opus、subagent 和 effort 变量；智谱使用 `ANTHROPIC_AUTH_TOKEN`。

ChatGPT Codex 后端是 OpenAI Responses 协议，Claude Code 发出 Anthropic Messages 协议，二者不能只靠环境变量直连。该组合会明确返回“未写入”，不会制造表面成功。

> **未经测试声明：** 当前开发机未安装或未启动 Codex / Claude Code 做真实请求，两个目标的配置写入功能依据当前官方源码和 CC Switch 实现完成，并有格式级单元测试，但尚未做端到端验证。插件绝不会为了测试而安装这两个工具。

## 数据与安全

默认数据目录：

```text
$PASEO_HOME/coding-plan-manager
```

未设置 `PASEO_HOME` 时是 `~/.paseo/coding-plan-manager`。可用 `PASEO_CODING_PLAN_HOME` 单独覆盖。

```text
plans.json          # 不含明文凭据的 Plan 元数据
usage-cache.json    # 最近一次成功用量
secrets/<plan>.json # OAuth / API Key
```

- Unix 下目录权限为 `0700`，凭据文件为 `0600`。
- Paseo 当前没有插件级系统钥匙串 API，因此凭据和 Codex 自身的 `auth.json` 一样以本机文件保存，并非系统钥匙串加密。
- Windows 上 Node 的 mode 不能替代完整 DACL；应确保 Paseo 数据目录只允许当前用户访问。
- API Key 在表单中输入时存在于当前 Paseo 客户端内存，并通过现有的 Paseo RPC 连接提交一次；保存后 daemon RPC 不再返回明文凭据。日志中也不输出 token、Key、响应正文或 Authorization header。
- 用量请求只允许预定义的精确 HTTPS hostname，禁用跨域 redirect，并限制响应体大小。
- 成功快照会持久化；网络失败时界面显示旧数据和 `STALE`，不会把未知值伪装成 0。

配置写入采用同目录临时文件、`fsync` 和 rename。涉及 auth + config 两个文件时先写 auth，第二步失败会恢复 auth 快照；这能做到崩溃恢复友好，但操作系统不支持跨两个文件的全局原子事务。切换后建议新建 CLI 会话。

## 私有 API 提示

三个用量接口都属于产品内部接口，不是稳定的公共计费 API，供应商可能随时修改路径或响应字段：

- Codex：`https://chatgpt.com/backend-api/wham/usage`
- 智谱：`https://<region>/api/monitor/usage/quota/limit`
- Kimi：`https://api.kimi.com/coding/v1/usages`

解析器保留未知窗口，并兼容当前常见 snake_case / camelCase reset 字段；接口变更时请先查看 Paseo 插件日志。

## 开发

```bash
npm run typecheck
npm test
```

测试覆盖三个用量响应的归一化、OpenCode JSONC 注释保留、Codex TOML 管理块以及 Claude Code 环境投影。

## 参考实现

- [Paseo plugin reference](https://paseo.sh/docs/plugins/reference)
- [vscode-glm-plan-usage-plugin](https://github.com/sage-z-cn/vscode-glm-plan-usage-plugin)
- [kimi-usage](https://github.com/Kayuii/kimi-usage)
- [openai-oauth-copilot-chat](https://github.com/grikomsn/openai-oauth-copilot-chat)
- [CC Switch](https://github.com/farion1231/cc-switch)
- [OpenAI Codex](https://github.com/openai/codex)
- [OpenCode](https://github.com/anomalyco/opencode)

本项目没有复制上述项目的源码；它们用于核对接口、配置格式和安全边界。
