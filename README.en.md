# dsh-agent-session-tools

**Session tools for DeepSeek Harness agents: create a session, and deliver a message into any session.**

[简体中文](README.md) | English

## The gap it fills

Inside Harness an agent can only message other sessions through two narrow paths:

- `agentTeams.sendMessage` — only to its own teammates;
- `subagents.sendMessage` — only to a direct parent or a directly continuable child.

There is **no general entry point** for an arbitrary session. So an agent cannot hand work to a standalone session, push a result back into another conversation, or stop a stuck one.

This plugin adds that entry point. It does not reimplement anything: it calls the already-composed Host service `ctx.sessionController` — the very admission path the Web composer uses. An injected message therefore lands in the target session as a durable user message, not as a side-channel write.

## Why it stays light

- **Cross-platform by construction.** macOS, Linux and Windows run the same code. Path validation follows the **host platform**: on macOS/Linux, `E:\proj` is not mislabelled "relative" — it is rejected with a message saying it is a Windows path this Host cannot use. The test matrix runs on all three.
- **Single file, zero dependencies, zero build.** The runtime is just `index.js`, using only built-in `node:path`; nothing third-party is bundled and there is no build step. Edit `index.js`, **restart DSH, and the change is live** — no reinstall, no compile, no bundling wait. (The restart is required: the Loader caches imported Host modules per package name, so disabling/enabling does not re-read the file.)
- **Uninstalling leaves nothing behind.** Removal drops the plugin's loader row and its package directory — no config writes, no data directory, no background tasks, no takeover of existing sessions. Harness returns to its pre-install state. The one caveat is usage rather than installation: **messages already injected stay in the target session logs; uninstalling does not recall them.**

## Tools

| Tool | What it does | Underlying call |
|---|---|---|
| `session_create` | Create a session, return its `sessionId` | `sessionController.create()` |
| `session_inject` | Deliver one message into a session | `sessionController.prompt()` |
| `session_list` | List visible sessions, to find an id | `sessionController.list()` |
| `session_cancel` | Cancel a session's running turn | `sessionController.cancel()` |

### session_create

| Parameter | Required | Notes |
|---|---|---|
| `cwd` | no | **Absolute** working directory for the new session, in the host's own style (`/home/me/proj` on macOS/Linux, `C:\proj` on Windows); omit for the Harness default. A relative path is rejected rather than resolved against the Host process's cwd, and a path written for the other platform is rejected with a message naming the mismatch |
| `agentPreset` | no | Agent preset id; omit for the configured default |
| `title` | no | Set the title right after creation |

Returns `{ sessionId, agentPreset?, title?, warning? }`. A failed title is non-fatal: the session is still created and the reason ends up in `warning`.

### session_inject

| Parameter | Required | Notes |
|---|---|---|
| `sessionId` | yes | Target session |
| `message` | yes | Non-empty text |
| `mode` | no | `queue` (default: handled at the next turn) or `steer` (applied at the next step boundary) |

Returns `{ accepted, sessionId, mode, requestId }`.

- `queue` — enters the session inbox and is handled when the next turn starts; it also wakes an idle session.
- `steer` — takes effect at the session's next step boundary, to change direction mid-turn.

### session_list

| Parameter | Required | Notes |
|---|---|---|
| `limit` | no | Rows to return, default 20, range 1–100 |

Read-only, never wakes a cold session. Each row carries `running` / `blank` / `origin` / `cwd`.

### session_cancel

| Parameter | Required | Notes |
|---|---|---|
| `sessionId` | yes | Target session |

Sends a cancel request and **keeps** queued messages. When a session is stuck on an unsettled tool call this is the only way back: the turn ends, then the queue moves.

Returns `{ sessionId, accepted, reason? }`. Only `accepted=true` means a turn was really cancelled; otherwise `accepted=false` carries a `reason`:

| `reason` | Meaning | Why it matters |
|---|---|---|
| `idle` | the session exists but has no running turn | no false "cancel requested"; queued messages are untouched |
| `not-found` | no such session, or not in this profile | a structured answer instead of a thrown error, so the agent can fix the id |

(0.1.0 passed the service's answer straight through: an idle session also reported `accepted=true`, and an unknown id threw. 0.1.1 reads the store first, so the answer matches reality.)

## Install

### From GitHub (recommended)

```sh
dsh plugin --profile desktop add github:zgq0106/dsh-agent-session-tools
```

Replace `--profile` with your own profile name. The package has no build step.

### From a local checkout

Clone the repo, then either point the Harness plugin manager at the directory's absolute path, or link it into `<profile>/node_modules/dsh-agent-session-tools` and append to that profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: agent-session-tools
      name: dsh-agent-session-tools
```

### Restart is required

The Loader caches an imported Host module per package name: disabling/enabling or reinstalling the bundle does **not** re-read `index.js`. Restart DSH after installing.

### Relation to the private `@local/dsh-session-control`

This package is the generalized release of the author's private version, with the same tools and behaviour. If you have that private version installed, remove it first — both register the same tool names (`session_create` etc.), and running them together is untested.

## Safety

- **Injection is a real write.** The message joins the target session's log as if spoken there, and cannot be recalled. Try a disposable session first.
- **No content review.** The plugin forwards faithfully; the calling agent owns the content.
- **Empty text is rejected** before it reaches the service.
- **Attribution:** the plugin runs in the Host process without a Remote principal, so injected messages are attributed to the **owner**, at the same level as messages you type.
- **Idempotency:** every call mints a unique `requestId`; a repeated id returns the original acceptance instead of inserting twice.

## Similar plugins

- [`dsh-session-bridge`](https://github.com/heartmove/dsh-session-bridge) — creates top-level sessions via prompts, sends messages, waits for replies, reads messages, looks sessions up by name across workspaces, plus monitoring and subagent handling. Much broader.
- [`dsh-session-hub`](https://github.com/Asaiuta/dsh-session-hub) — aggregates and controls sessions across multiple remote dsh web servers from one pane.

This package stays deliberately narrow: a **Host-only tool layer** that calls `sessionController` directly — no prompt indirection, no UI, no dependency on the open page, no scheduling or aggregation. Four tools, strict parameters, explicit errors, idempotent requests.

## Compatibility

| Item | Value |
|---|---|
| Verified on | DSH `0.2.1-rc.5` (Windows, Node 24.21.0) and `0.2.2-rc.3` (macOS arm64, Node 26.12.1) |
| Platforms | macOS / Linux / Windows — only `node:path` and `process.platform`, no native addon, no platform-specific dependency |
| Node | `^22.19.0 \|\| >=24.0.0` (same range as DSH ecosystem plugins) |
| Dependencies | Only `ctx.sessionController` and built-in `node:path`; nothing bundled |
| Build | None — `index.js` is the shipped artifact |

`dsh.compatibility.dshReleases` lists only versions that were actually tested. Other releases will most likely work (the surface used is stable), but treat that as unverified.

If the profile does not compose `@deepseek-ai/dsh-api-session-controller`, the plugin still loads and its tools stay registered; calls then fail with an error naming the missing service instead of failing silently.

## Development

```sh
node --check index.js
node test/smoke.mjs        # or npm test
```

`test/smoke.mjs` runs offline: a fake Cordis context and a stub `sessionController` drive the real `apply()`, covering registration shape, every `execute()` path, argument rejection, idempotency, and the three `session_cancel` outcomes (running / idle / not-found). No DSH process, port or interaction needed — 74 assertions.

Fixtures pick their path style from `process.platform`, so the same suite runs on macOS, Linux and Windows; CI (`.github/workflows/ci.yml`) runs it on all three × Node 22/24.

## License

MIT
