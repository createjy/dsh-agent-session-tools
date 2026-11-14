# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 0.2.0 — 2026-11-14

把内核里早就有、插件却一直没暴露的三个只读能力接出来：`session_state`、`session_wait`、`session_search`。同时补上真正生效的宿主版本门禁。

### 新增

- **`session_state`**：`sessionController.state()` 的封装，返回 `running` / `active` / `cursor` / `queued` / `pendingInput`。用于“先看它在不在跑、在等什么”而不必唤醒会话。
- **`session_wait`**：`sessionController.wait()` 的封装。等会话进入 `idle` / `input-required` / `timeout`，并回传窗口内最后一条助手消息的纯文本与 `inputTokens`。这是 `sleep` + 轮询的替代品；`inputTokens` 取自 `assistant/message` 事件的 `usage.inputTokens`——`state()` 里没有任何 token 字段，上下文水位只能从这里读。
- **`session_search`**：`sessionController.search()` 的封装，按字面文本（非语义）检索会话历史，返回 `sessionId` + `snippet` + `hasMore`，用于在不知道 id 时先定位。

### 变更

- `engines.dsh: ">=0.2.1-rc.5 <0.3.0"`：DSH 的 app-boot 在激活前评估 `engines.dsh`（缺失时回落到 DSH peer 依赖），这是真正会拦住不兼容宿主的声明。`dsh.compatibility.dshReleases` 保留，但它只是展示字段，运行时不读取。
- 冒烟测试 74 → 117 项断言（Windows 上 115），覆盖七个工具的全部 `execute()` 路径。

## 0.1.1 — 2026-11-14

首个**跨平台**版本：macOS / Linux / Windows 用同一份代码、同一份测试。起因是在 macOS 上跑 `npm test` 直接崩，顺手把一处会误导的报错和两处与结果对不上的返回值一起修了。

### 修复

- **冒烟测试在 macOS/Linux 上崩溃**：`test/smoke.mjs` 拿 `E:\proj` 当“绝对路径”夹具，而 `node:path` 的 `isAbsolute('E:\proj')` 在 POSIX 上返回 `false`，测试在第 105 行抛异常退出。夹具改为按 `process.platform` 取宿主平台的路径风格（`C:\proj` / `/home/me/proj`），`session_list` 的样例 `cwd` 同样跟随宿主。
- **`session_cancel` 在空闲会话上谎报成功**：0.1.0 直接透传 `sessionController.cancel()`，而它在没有活动轮次时也返回 `accepted: true`，工具于是渲染“已请求取消…”却什么也没取消。现在先查存储再发取消：会话空闲返回 `accepted=false, reason='idle'`，且**不**调用取消。
- **`session_cancel` 对不存在的会话抛错**：改为返回 `accepted=false, reason='not-found'`，渲染“找不到会话 …”。取消一个不存在的会话不是异常，是“没什么可取消”。
- **跨平台 `cwd` 的报错会误导**：在 macOS/Linux 上传 `E:\proj`，0.1.0 报“收到的是相对路径”，而它其实是 Windows 绝对路径。现在单独识别 `C:\x` / `C:/x` / `\\server\share` 形式，说明“这是 Windows 路径、当前 Host 跑在 darwin 上、请传 POSIX 绝对路径”；相对路径的报错也补上宿主平台与示例。

### 变更

- `session_cancel` 的输出新增 `reason` 字段（`idle` / `not-found`，成功时省略）。
- `session_cancel` 的说明文字写明“空闲或不存在时返回 accepted=false 并说明原因”。
- `session_create` 的 `cwd` 参数说明改为平台中性表述。
- `package.json` 的 `dsh.compatibility.dshReleases` 增加 `0.2.2-rc.3`（macOS 实测）。

### 测试

- 断言 59 → 74：新增 `session_cancel` 的三种结局（running / idle / not-found）、存储不可读时的回退路径、跨平台 `cwd` 拒绝。
- 新增 `.github/workflows/ci.yml`：macOS / Ubuntu / Windows × Node 22 / 24 全矩阵跑 `node --check` + `npm test`。

## 0.1.0 — 2026-11-01

首个公开版本，由作者自用的私有版 `@local/dsh-session-control` 泛化而来。

### 新增

- `session_create`：新建会话，可指定工作目录、agent 预设、标题。
- `session_inject`：向任意会话注入消息，支持 `queue`（排队）与 `steer`（引导）两种语义。
- `session_list`：列出可见会话，带运行状态与工作目录。
- `session_cancel`：取消某个会话当前轮次，不丢弃已排队消息。

### 相对私有版的改动

- 包名去掉 `@local` 私有标识，改为可公开安装的 `dsh-agent-session-tools`；补齐 `repository` / `homepage` / `bugs` / `license` / `keywords` / `engines` / `dsh.compatibility` 等发布元数据。
- `session_create` 的 `cwd` 增加绝对路径校验：相对路径直接拒绝，不再交给宿主进程按它自己的当前目录解析。
- 错误信息与 `requestId` 前缀带上插件名，多插件排查时能一眼看出谁报的。
- 新增 `locale/zh.json`、`locale/en.json`、原创图标 `icon.svg`。
- 新增离线冒烟测试 `test/smoke.mjs`（59 项断言），不依赖 DSH 进程即可运行。
- 新增双语 README（`README.md` / `README.en.md`）与 `PUBLISHING.md`。
- README 增加「特点」一节，写明两条工程属性：单文件／零依赖／零构建、改完重启即生效；卸载零副作用（并注明已注入的消息不会被卸载撤销）。
