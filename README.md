# Paseo Coding Plan Manager

一个本地 Paseo 插件，用于集中管理多个 Codex / ChatGPT、智谱 GLM Coding Plan 和 Kimi Coding Plan，查看额度与重置时间，并把指定 Plan 写入 OpenCode、Codex 或 Claude Code 的本机配置。

## 功能

- 同一 provider 可保存多个 Plan；每个 Plan 只保存账号信息和凭据，不绑定目标模型。
- Codex Plan 从 `auth.json` 导入，支持指定 `ChatGPT-Account-ID`。
- 智谱和 Kimi Plan 使用 API Key；保存后 daemon 不会把明文 Key 返回给客户端。
- 管理界面打开期间每 60 秒自动刷新，也可手动刷新。
- 每个 Plan 可独立选择用量查询直连或使用 Paseo daemon 的网络代理。
- 展示 Codex 主/次/附加限额、智谱新 `CREDIT_LIMIT` 与旧 `TOKENS_LIMIT` 的 5 小时/周窗口及 MCP 限额、Kimi 周额度/全部限流窗口/并发上限。
- Codex 和智谱额外展示服务端 7/30 天 Token 活动；Kimi 每 5 分钟至多保存一个本地配额快照并保留 7 天。
- 应用 Plan 时再为目标工具选择 1–16 个模型，首个作为当前默认；模型列表仅用于本次写入，不保存到 Plan。
- 将所选模型写入 OpenCode 自定义 provider、智谱 Codex 模型目录或 Claude Code model picker，同时保留无关配置和 JSONC 注释。
- 检测 `opencode`、`codex`、`claude` 是否存在；插件不包含、下载或安装任何 CLI。

## Workspace 标签页

插件通过 Paseo Workspace Panel API 展示完整管理界面。打开后，**Coding Plans** 会作为标签出现在当前 Workspace 主区域，与 Agent 标签并列；它不再占用全局侧栏。

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

安装后进入任意 Workspace，通过 `Ctrl+K` / `Cmd+K` 搜索 **Open Coding Plans** 或 **Open and refresh Coding Plan usage** 打开标签页。

## 添加 Plan

### Codex / ChatGPT

导入时可选择两种方式：

- **从路径读取**：默认读取 `$CODEX_HOME/auth.json`，未设置 `CODEX_HOME` 时读取 `~/.codex/auth.json`。
- **直接输入 JSON**：把完整 `auth.json` 内容粘贴到多行输入框，不要求 Paseo daemon 能访问原文件路径。

两种方式都会把解析后的凭据复制到插件的私有数据目录，原始 JSON 不会进入 Plan 元数据或 dashboard。路径模式会记住来源文件以便后续同步；直接输入模式不保存来源路径，编辑时可粘贴新内容更新凭据，留空则保留现有副本。

多个 Codex Plan 有两种方式：

- 为不同账号准备不同 `CODEX_HOME`，添加时分别填写其 `auth.json` 路径。
- 同一个 OAuth 身份有多个 ChatGPT workspace 时，多次导入同一个文件并填写不同 Account ID。

使用路径模式时，插件每次查询和切换前会检查来源 `auth.json`；只有 JWT 中的 OAuth 用户身份明确相同且来源 generation 更新时，才会同步较新的副本。写入 OpenCode/Codex 前还会比较目标文件：同身份目标 token 更新时先吸收目标 generation，generation 冲突或身份无法判断时拒绝覆盖。不同 ChatGPT workspace 的 Account ID 不会被误当成不同登录身份。插件不会擅自兑换旋转 refresh token，因为 Codex / OpenCode 同时刷新同一个 token 可能让另一个客户端失效。若副本已过期，请先用对应账号运行 Codex 刷新，再点“编辑 / 重新导入”；直接输入模式需要在编辑表单中重新粘贴更新后的 JSON。

### 智谱 GLM

支持三个固定区域：

- 中国区：`open.bigmodel.cn`
- Global / Z.AI：`api.z.ai`
- 中国区 Dev：`dev.bigmodel.cn`

当前额度查询访问所选区域的 `/api/monitor/usage/quota/limit`，30 天 Token 活动查询访问 `/api/monitor/usage/model-usage`；后者的小时桶会在 daemon 上按自然日汇总。`Authorization` 使用原始 API Key，不添加 `Bearer`。

### Kimi Coding

用量查询访问 `https://api.kimi.com/coding/v1/usages`，使用 `Bearer` API Key 和 Kimi CLI User-Agent。

Kimi 没有可用的账号级历史接口。管理界面打开期间仍每 60 秒查询一次当前额度，但 `usage-cache.json` 每 5 分钟至多追加一个快照并只保留最近 7 天；关闭界面期间插件不会为了补齐历史而主动请求。窗口的 `resetTime` 变化或已用百分比下降会被记录为重置，界面中的“本周期增量”会从该点重新计算。这些值是套餐配额百分比，不会被标成 Token。

### Token 活动与配额

Codex 当前额度仍来自 `/backend-api/wham/usage`；按日 Token 活动来自 `/backend-api/wham/profiles/me`。Token 数与套餐额度消耗不是线性关系，因此界面把“Token 活动”和当前额度进度条分区展示。历史请求失败时会继续显示上次成功的历史并标记为缓存，不影响当前额度刷新。

## 用量查询网络代理

每个 Plan 的添加/编辑表单都有“用量查询代理”开关。Codex 新 Plan 以及从旧数据迁移的 Codex Plan 默认开启，智谱和 Kimi 默认关闭。

开启时，插件显式使用 Paseo daemon 环境中的 `HTTPS_PROXY`，未设置时回退到 `HTTP_PROXY`，并遵守 `NO_PROXY`；关闭时强制直连。若 Plan 开启了代理但 daemon 没有配置这两个变量，界面会显示明确错误，而不是静默回退直连。

这里的网络代理只负责访问供应商 HTTPS 用量接口，与 Codex/Claude Code 配置投影所说的协议转换代理不是同一种功能。

## 配置投影

点击 Plan 卡片上的“配置到…”后，插件会按 provider 和目标工具预填推荐模型。可在确认写入前选择并排序最多 16 个模型 ID；首个模型是目标工具的当前默认，整个列表仅用于本次配置，不会保存回 Coding Plan。

| Plan | OpenCode | Codex | Claude Code |
| --- | --- | --- | --- |
| Codex OAuth | 支持；首个模型为默认，不修改内置 OpenAI 目录 | 支持；首个模型为默认，写入原生 Codex auth，不修改内置目录 | 不直连；需要协议转换代理，插件会拒绝写入假配置 |
| 智谱 API Key | 支持多模型目录，首个为默认 | 中国区和 Z.AI Global 支持原生 Responses 多模型目录；Dev 未验证 | 支持多模型 picker，未经端到端测试 |
| Kimi API Key | 支持多模型目录，首个为默认 | 需要 Chat-to-Responses 代理，插件不写入 | 支持多模型 picker，未经端到端测试 |

### OpenCode

路径遵循 OpenCode 当前规则：

- 配置：`OPENCODE_CONFIG`，否则 `OPENCODE_CONFIG_DIR` / `$XDG_CONFIG_HOME/opencode` / `~/.config/opencode`。
- 凭据：`$XDG_DATA_HOME/opencode/auth.json`，否则 `~/.local/share/opencode/auth.json`。
- 已存在 `opencode.jsonc` 时优先修改它，否则使用 `opencode.json`。

智谱和 Kimi 会把本次所选模型及其 context/output、输入输出模态、推理、附件、工具调用和 temperature 能力写入 `provider.zhipu.models` 或 `provider.kimi.models`；GLM 还会写入 `reasoning_content` interleaved 协议字段。首个模型用于更新顶层 `model`；未知自定义模型已有的能力声明不会被覆盖。插件只更新该 provider 中由自身管理的连接和模型字段，保留用户的 timeout、headers、其他模型及 JSONC 注释。Codex OAuth 只更新顶层默认模型，不改 OpenCode 内置 OpenAI 模型目录。插件还会更新对应 auth 条目，其他 provider、插件、MCP 和 skills 会保留。若设置了 `OPENCODE_CONFIG_CONTENT` 或 `OPENCODE_AUTH_CONTENT`，文件修改不会生效，因此插件会拒绝操作。

OpenCode 的 Active 状态按 provider 分槽保存：Codex、智谱和 Kimi 各自最多保留一个 Plan，因此三个 provider 的凭据和目录状态可以同时共存；再次应用同一 provider 的 Plan 只替换该 provider 的记录。不过 OpenCode 顶层 `model` 始终只有一个，最近一次成功应用的 Plan 首个模型是当前默认。Codex 和 Claude Code 的 Active 状态仍各自是单例，后一次成功应用会替换该目标先前的 Plan。

### Codex

路径为 `$CODEX_HOME` 或 `~/.codex` 下的 `auth.json` 和 `config.toml`。首个所选模型写入根级默认。插件用结构化 TOML parser 在写入前后校验文件，保留其他 TOML 表，只更新根级模型选择和带有以下标记的 provider 块；无法安全修改的 quoted/特殊布局会拒绝写入，而不是生成重复键：

```toml
# BEGIN paseo-coding-plan-manager
# ...
# END paseo-coding-plan-manager
```

Codex 自定义 provider 要求 OpenAI Responses wire API。当前能力按供应商公开文档处理：

- Z.AI Global 使用 `https://api.z.ai/api/v1`，智谱中国区使用 `https://open.bigmodel.cn/api/v1`；两者都是官方 Responses 端点。插件把全部所选模型及各自 metadata 写入独立模型目录，同时写入 `experimental_bearer_token` 和 `wire_api = "responses"`，不覆盖 Codex OAuth `auth.json`。`glm-5.3` 使用 1,048,576 context window，其他模型使用 204,800。
- 智谱 Dev 尚无已验证的 Responses 端点；Kimi Coding 公开的是 Chat Completions 接口。二者需要类似 CC Switch 的本地双向协议转换代理，本插件当前不内置，因此按钮显示“需代理”，daemon 也会拒绝写入。

Codex OAuth 切换只支持 `cli_auth_credentials_store = "file"` 或未显式配置存储模式。若设置为 `keyring`、`auto` 或 `ephemeral`，插件不会修改系统钥匙串，也不会声称切换成功。

### Claude Code

路径为 `$CLAUDE_CONFIG_DIR/settings.json` 或 `~/.claude/settings.json`。插件以首个所选模型设置 `env` 中的默认模型，并替换自身标记的 `modelPicker.options`；真正的用户选项和 `replaceBuiltInOptions` 会保留，因此切换 Kimi/智谱或重新选择模型时不会留下不可用的旧 provider 项。多模型候选需要 Claude Code 2.1.242 或更高版本。插件同时保留 permissions、hooks、plugins 及其他环境变量，并合并对应 profile 的 onboarding 状态：默认是 `~/.claude.json`；设置 `CLAUDE_CONFIG_DIR` 时使用该目录内已有的 `.config.json`，否则使用 `.claude.json`。Kimi 额外设置官方要求的 `penguinModeOrgEnabled`。Kimi 使用 `ANTHROPIC_API_KEY`，并同时设置 Fable、Haiku、Sonnet、Opus、subagent 和 effort 变量；智谱使用 `ANTHROPIC_AUTH_TOKEN`。只有全部所选 Kimi 模型均为 `k3` / `k3[1m]` 时才启用 1,048,576 context window，混合列表回退到 262,144。

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
usage-cache.json    # 最近一次成功用量、服务端 Token 活动和 Kimi 本地快照
secrets/<plan>.json # OAuth / API Key
```

- Unix 下目录权限为 `0700`，凭据文件为 `0600`。
- Paseo 当前没有插件级系统钥匙串 API，因此凭据和 Codex 自身的 `auth.json` 一样以本机文件保存，并非系统钥匙串加密。
- Windows 上 Node 的 mode 不能替代完整 DACL；应确保 Paseo 数据目录只允许当前用户访问。
- API Key 或直接粘贴的 Codex `auth.json` 在表单中输入时存在于当前 Paseo 客户端内存，并通过现有的 Paseo RPC 连接提交一次；保存后 daemon RPC 不再返回明文凭据。日志中也不输出 token、Key、响应正文或 Authorization header。
- 用量请求只允许预定义的精确 HTTPS hostname，禁用跨域 redirect，并限制响应体大小。
- 成功快照会持久化；网络失败时界面显示旧数据和 `STALE`，不会把未知值伪装成 0。
- `usage-cache.json` 写入前硬限制为 2 MiB，依次裁剪最旧的本地配额历史、Token 活动和超大快照；旧版本留下的超限文件会被当作空缓存恢复，不会阻塞 dashboard、刷新或删除操作。
- `plans.json` 当前版本为 v4。有效的 v1/v2/v3 数据会在首次读取时直接升级到 v4：移除早期 Plan 中的目标模型字段，补充 Plan 级网络代理开关，并把 Active 状态校验到现有 Plan。v3 只记录了一个 OpenCode Plan，因此迁移只能依据该 Plan 元数据中的精确 provider 恢复对应的一个 provider 槽，无法恢复当时未记录的其他 OpenCode provider；不会根据 Plan ID 猜测 provider。Codex 和 Claude Code 仍分别迁移其单例引用。

配置写入采用同目录临时文件、`fsync` 和 rename。涉及 auth + config 两个文件时先写 auth，第二步失败会恢复 auth 快照；这能做到崩溃恢复友好，但操作系统不支持跨两个文件的全局原子事务。切换后建议新建 CLI 会话。

## 私有 API 提示

三个用量接口都属于产品内部接口，不是稳定的公共计费 API，供应商可能随时修改路径或响应字段：

- Codex：`https://chatgpt.com/backend-api/wham/usage`
- Codex 历史：`https://chatgpt.com/backend-api/wham/profiles/me`
- 智谱：`https://<region>/api/monitor/usage/quota/limit`、`/api/monitor/usage/model-usage`
- Kimi：`https://api.kimi.com/coding/v1/usages`

解析器保留未知窗口，并兼容当前常见 snake_case / camelCase reset 字段；接口变更时请先查看 Paseo 插件日志。

## 开发

```bash
npm run typecheck
npm test
```

测试覆盖三个当前用量响应、Codex/智谱历史归一化、Kimi 快照节流与重置、多模型列表、OpenCode JSONC 多模型目录、Codex TOML/模型 metadata 以及 Claude Code 环境和 model picker 投影。

## 参考实现

- [Paseo plugin reference](https://paseo.sh/docs/plugins/reference)
- [vscode-glm-plan-usage-plugin](https://github.com/sage-z-cn/vscode-glm-plan-usage-plugin)
- [kimi-usage](https://github.com/Kayuii/kimi-usage)
- [openai-oauth-copilot-chat](https://github.com/grikomsn/openai-oauth-copilot-chat)
- [CC Switch](https://github.com/farion1231/cc-switch)
- [OpenAI Codex](https://github.com/openai/codex)
- [OpenCode](https://github.com/anomalyco/opencode)

本项目没有复制上述项目的源码；它们用于核对接口、配置格式和安全边界。
