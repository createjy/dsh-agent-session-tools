# dsh-agent-session-tools

**给 DeepSeek Harness 的 Agent 用的会话工具：新建一个会话，往任意会话里投递消息。**

给 Agent 一组能直接操作会话的工具——不用绕提示词、不用打开界面，就能从当前会话里新建一个对接会话，或把一句话塞进另一个正在跑的会话。

[English](README.en.md) | 简体中文

## 它解决什么问题

Harness 内核里，Agent 想给「别的会话」发消息，原本只有两条窄路：

- `agentTeams.sendMessage`：只能发给自己的 teammate；
- `subagents.sendMessage`：只能发给直接父会话或直接可续子会话。

**没有对任意会话的通用入口。** 于是常见需求全都做不了：从主会话派活给一个独立会话、把结论同步回另一条对话、叫停一个卡住的会话。

本插件补上这个入口。它不自己造轮子，而是直接调用已组合的宿主服务 `ctx.sessionController`——也就是 Web 界面输入框「发送消息」走的同一条投递路径。因此注入的消息在目标会话里就是一条真实的用户消息，不是某种旁门注入。

## 特点

- **单文件、零依赖、零构建**：运行时代码只有 `index.js` 一个文件，只用内置 `node:path`，不打包任何第三方依赖，也没有构建步骤。改完 `index.js` **重启 DSH 即生效**——不用重装、不用编译、不用等打包。（不重启不生效：Loader 按包名缓存已导入的模块，禁用/启用也不会重读。）
- **跨平台**：macOS / Linux / Windows 同一份代码。路径校验按**宿主平台**判定——在 macOS/Linux 上传 `E:\proj` 不会被当成“相对路径”，而是明确告诉你这是 Windows 路径、当前 Host 用不了。测试矩阵在三个平台各跑一遍。
- **卸载无副作用**：卸载只移除这个插件的加载行和包目录。它不写任何配置、不建数据目录、不注册后台任务、不接管现有会话，卸完 Harness 回到装之前的样子。唯一要说明的是使用痕迹——**已经注入的消息留在目标会话日志里，卸载不会撤销它们**；那是注入这一步造成的，不是卸载造成的。

## 提供的工具

| 工具 | 作用 | 底层调用 |
|---|---|---|
| `session_create` | 新建会话，返回 `sessionId` | `sessionController.create()` |
| `session_inject` | 向指定会话投递一条消息 | `sessionController.prompt()` |
| `session_list` | 列出可见会话，用于找 `sessionId` | `sessionController.list()` |
| `session_cancel` | 取消某会话当前正在跑的轮次 | `sessionController.cancel()` |
| `session_state` | 读被动状态：是否在跑、排队几条、在等什么交互 | `sessionController.state()` |
| `session_wait` | 等会话空闲/等输入/超时，并取回最新助手消息 | `sessionController.wait()` |
| `session_search` | 按字面文本检索会话历史，定位 id | `sessionController.search()` |

### session_create

| 参数 | 必填 | 说明 |
|---|---|---|
| `cwd` | 否 | 新会话工作目录的**绝对路径**，且须与宿主平台一致（macOS/Linux 传 `/home/me/proj`，Windows 传 `C:\proj`）；省略用 Harness 默认目录。相对路径会被拒绝（宿主进程的当前目录调用方看不到，不替调用方猜）；跨平台路径（如在 POSIX 上传 Windows 盘符路径）也会被拒绝，并说明是哪一侧不匹配 |
| `agentPreset` | 否 | 预设 id；省略用默认预设 |
| `title` | 否 | 创建后立即设置的标题 |

返回 `{ sessionId, agentPreset?, title?, warning? }`。标题设置失败不影响会话创建，失败原因放进 `warning`。

### session_inject

| 参数 | 必填 | 说明 |
|---|---|---|
| `sessionId` | 是 | 目标会话 |
| `message` | 是 | 注入的文本，不能为空 |
| `mode` | 否 | `queue`（默认，排队到下一轮）或 `steer`（立即引导当前轮） |

返回 `{ accepted, sessionId, mode, requestId }`。两种投递语义：

- `queue`：消息进入该会话收件箱，在它下一轮开始时被处理；目标空闲时也会被唤醒起一轮。
- `steer`：消息在该会话最近一个步骤边界生效，用于中途改变方向。

### session_list

| 参数 | 必填 | 说明 |
|---|---|---|
| `limit` | 否 | 最多返回多少条，默认 20，范围 1–100 |

只读存储，不会唤醒冷会话。每行带 `running` / `blank` / `origin` / `cwd`，便于挑目标。

### session_state

| 参数 | 必填 | 说明 |
|---|---|---|
| `sessionId` | 是 | 目标会话 |

返回 `running` / `active` / `cursor` / `queued`（排队未处理的输入条数）/ `pendingInput`（`approval`、`question`、`other`）。只读，不唤醒冷会话。

### session_wait

| 参数 | 必填 | 说明 |
|---|---|---|
| `sessionId` | 是 | 目标会话 |
| `timeoutMs` | 否 | 最长等待毫秒数，默认 60000，范围 1000–600000 |
| `afterSeq` | 否 | 只看该事件序号之后的记录 |
| `maxMessages` | 否 | 最多返回多少条事件记录，默认 200，上限 5000 |

返回 `reason`（`idle` / `input-required` / `timeout`）、`running`、`cursor`、`queued`、`text`（该窗口内最后一条助手消息的纯文本）、`inputTokens`（该次模型请求的输入 token 数，来自 `assistant/message` 事件的 `usage.inputTokens`）、`truncated`。

存在的意义是替代 `sleep` 轮询：由宿主在事件发生时返回，而不是让 Agent 反复查。`inputTokens` 是上下文水位唯一的真实来源——`state()` 里没有任何 token 字段。

### session_search

| 参数 | 必填 | 说明 |
|---|---|---|
| `query` | 是 | 要检索的字面文本（不是语义检索） |
| `limit` | 否 | 最多返回多少条，默认 10，范围 1–50 |

返回 `items: [{ sessionId, snippet }]` 与 `hasMore`。

### session_cancel

| 参数 | 必填 | 说明 |
|---|---|---|
| `sessionId` | 是 | 目标会话 |

只发取消请求，**不丢弃**已排队的消息。会话卡在未结算的工具调用上时，它是唯一能救回来的手段：取消后那一轮结束，队列才继续动。

返回 `{ sessionId, accepted, reason? }`。`accepted=true` 才代表真有轮次被取消；否则 `accepted=false` 并带 `reason`：

| `reason` | 含义 | 说明 |
|---|---|---|
| `idle` | 会话存在但没有正在跑的轮次 | 不会误报成“已取消”；排队的消息原样保留 |
| `not-found` | 会话不存在 / 已删除 / 不属于当前 profile | 不再抛错，Agent 能直接改 id 重试 |

（0.1.0 的行为是直接透传宿主服务：空闲会话也返回 `accepted=true`，未知 id 则抛错。0.1.1 先查存储再发取消，语义才与结果对得上。）

## 安装

### 方式一：从 GitHub 装（推荐）

```sh
dsh plugin --profile desktop add github:zgq0106/dsh-agent-session-tools
```

`--profile` 换成你自己的 profile 名（`dsh` 的插件目录就是 profile 目录，包里没有构建步骤，装完直接可用）。

### 方式二：本地目录

把仓库 `git clone` 到本机，然后二选一：

- 用 Harness 的插件管理器，安装目标填该目录的**绝对路径**（宿主会读它的 `package.json`，并写进 profile 的 `dsh.profile.bundles`）；
- 或手工链接：把目录链接到 `<profile>/node_modules/dsh-agent-session-tools`，再在该 profile 的 `cordis.patch.yml` 追加：

```yaml
- insert:
    - id: agent-session-tools
      name: dsh-agent-session-tools
```

### 装完要重启

Host 半侧（本包全部代码）按包名缓存已导入的模块：**禁用/启用、重装 bundle 都不会重新读取 `index.js`，只有重启 DSH 才保证新代码生效。**

### 与旧版 `@local/dsh-session-control` 的关系

本包由作者此前自用的私有版泛化而来，工具与行为一致。若你之前装过那个私有版，请先移除再装本包——两个插件会注册同名工具（`session_create` 等），同时启用属于未测组合。

## 安全边界

- **注入是真实写入**：消息会进目标会话日志，等于有人在那儿说了那句话，不可撤销。建议先拿一个不重要的会话试一次。
- **工具不做内容审查**：调用方（Agent）为注入内容负责；插件只是忠实转发。
- **空文本会被拒绝**：`prompt` 要求非空白文本或附件，插件侧先拦一次，错误信息直接说明原因。
- **消息归属**：插件在宿主进程内调用、不带 Remote 主体，因此注入的消息按 **owner** 归属，与你手打的消息同级。
- **幂等**：每次调用生成唯一 `requestId`；服务端对重复 `requestId` 返回原接受结果，不会重复插入。

## 与同类插件的区别

社区里已有相近的插件，动手前值得知道：

- [`dsh-session-bridge`](https://github.com/heartmove/dsh-session-bridge)：通过提示词创建顶层会话、发消息、等待回复、读消息、按会话名跨工作区查找，还带监控与子代理处置——功能比本包宽得多。
- [`dsh-session-hub`](https://github.com/Asaiuta/dsh-session-hub)：从同一面板聚合控制多台远程 dsh web 服务器上的会话。

本包刻意做得更窄：**纯宿主内工具层**，直接调 `sessionController`，不经提示词、不加界面、不依赖前台页面、不带定时与聚合。四个工具、参数严格、错误信息明确、`requestId` 幂等。窄的好处是行为和边界都容易预期——你要是只需要「建个会话」「往那边说句话」，它不会顺带做别的。

## 兼容性

| 项目 | 值 |
|---|---|
| 实测 DSH | `0.2.1-rc.5`（Windows，Node 24.21.0）、`0.2.2-rc.3`（macOS arm64，Node 26.12.1） |
| 平台 | macOS / Linux / Windows。只用 `node:path` 与 `process.platform`，无原生扩展、无平台相关依赖 |
| Node | `^22.19.0 \|\| >=24.0.0`（与 DSH 生态插件同口径） |
| 宿主版本门禁 | `engines.dsh: >=0.2.1-rc.5 <0.3.0`。DSH 的 app-boot 在装载前评估 `engines.dsh`（缺失时回落到 DSH peer 依赖），这是真正生效的兼容声明；`dsh.compatibility.dshReleases` 只是给 Plugin Manager 看的展示字段，运行时不读取 |
| 依赖 | 只用 `ctx.sessionController` 与内置 `node:path`，不打包任何第三方依赖 |
| 构建 | 无。`index.js` 就是发布产物 |

`package.json` 的 `dsh.compatibility.dshReleases` 只写**实测过**的版本，不声明没验证过的范围。别的版本大概率也能跑（只用了稳定的宿主服务接口），但请以你的实测为准。

宿主没有组合 `@deepseek-ai/dsh-api-session-controller` 时，插件仍会加载、工具仍在，但调用会返回一条说明缺什么服务的错误，而不是静默失败。

## 开发与测试

```sh
node --check index.js
node test/smoke.mjs        # 或 npm test
```

`test/smoke.mjs` 离线运行：用一个假的 Cordis 上下文和桩 `sessionController` 驱动真实的 `apply()`，覆盖注册形状、七个工具的每条 `execute()` 路径、参数拒绝、幂等、`session_cancel` 的三种结局（running / idle / not-found），以及 `session_wait` 的文本/token 抽取与参数钳制。不需要 DSH 进程、端口或交互，117 项断言（Windows 上 115 项，平台专属分支不同）。

测试夹具按 `process.platform` 取路径风格，所以同一份测试在 macOS、Linux、Windows 上都能跑；CI（`.github/workflows/ci.yml`）在三个平台 × Node 22/24 上各跑一遍。

## 许可

MIT
