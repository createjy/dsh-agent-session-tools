/**
 * dsh-agent-session-tools — Host half.
 *
 * Agent tools that let the model:
 *   1. create a brand-new Harness session,
 *   2. inject one message into any existing session (queued, or steering),
 *   3. list visible sessions (to find an id),
 *   4. cancel the running turn of one session,
 *   5. read one session's passive state (running, queue depth, pending input),
 *   6. wait for a session to become observable instead of polling with sleep,
 *   7. search session history for a literal string.
 *
 * Every one is a thin, faithful wrapper over the already-composed
 * `ctx.sessionController` Host service:
 *   - `create(request)`  -> { sessionId, agentPreset? }
 *   - `prompt(request)`  -> { accepted: true }
 *   - `list(request)`    -> { items: [...] }
 *   - `cancel(request)`  -> { accepted: boolean }
 *   - `state(request)`   -> { cursor, active, running, queue, pendingInput }
 *   - `wait(request)`    -> { reason, state, output: { records, truncated } }
 *   - `search(request)`  -> { items: [{ sessionId, snippet }], hasMore }
 *
 * `prompt` is the same admission path the Web composer uses, so an injected
 * message lands in the target Session log as a durable user message. Called
 * from the Host plugin (no Remote principal) it is attributed to the owner.
 * `requestId` makes retries idempotent: the service returns the original
 * acceptance instead of appending a second message.
 *
 * Nothing here re-implements DSH internals: if `sessionController` is missing
 * from the composed profile, the tools stay registered and fail with a message
 * that says exactly what is missing.
 */

import { isAbsolute } from 'node:path'

/** Host platform facts, used for path diagnostics (macOS/Linux vs Windows). */
const IS_WINDOWS = process.platform === 'win32'

/** `C:\\x`, `C:/x`, `\\server\share` — absolute on Windows, plain text on POSIX. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/

/** What an absolute path looks like on the Host that is running now. */
const PLATFORM_HINT = IS_WINDOWS ? 'C:\\proj 这样的 Windows 绝对路径' : '/home/me/proj 这样的 POSIX 绝对路径'

export const name = 'dsh-agent-session-tools'

/** Wait for the tool registry; `sessionController` is resolved lazily per call. */
export const inject = ['tools']

/** Resolve the session controller or fail with an actionable message. */
function controllerOf(ctx) {
  const service = ctx.get('sessionController')
  if (!service) {
    throw new Error(
      `${name}: sessionController 不可用。当前 profile 没有组合 @deepseek-ai/dsh-api-session-controller，无法创建、列出或注入会话。`,
    )
  }
  return service
}

/** One-shot abort signal for Host-side calls. */
function signalOf() {
  return new AbortController().signal
}

/** A request id unique enough for the service's idempotency check. */
function newRequestId() {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return `${name}-${uuid}`
  return `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Validate a caller-supplied working directory and return it unchanged.
 *
 * `node:path`'s `isAbsolute` is platform-bound: `E:\proj` is absolute on Windows
 * and plain relative text on macOS/Linux. Reporting a Windows path as "relative"
 * on a POSIX Host hides the real mistake, so each case gets its own message.
 */
function assertAbsoluteCwd(cwd) {
  if (isAbsolute(cwd)) return cwd
  if (!IS_WINDOWS && WINDOWS_ABSOLUTE.test(cwd)) {
    throw new Error(
      `cwd 是 Windows 绝对路径，但当前 Host 运行在 ${process.platform} 上，无法使用：${cwd}。请改传 ${PLATFORM_HINT}。`,
    )
  }
  throw new Error(
    `cwd 必须是绝对路径，收到的是相对路径：${cwd}（当前 Host 是 ${process.platform}，请传 ${PLATFORM_HINT}）`,
  )
}

/**
 * Best-effort state of one session: `'running' | 'idle' | 'missing' | 'unknown'`.
 *
 * `'unknown'` means the store could not be read; callers then let the service's
 * own answer decide instead of inventing one.
 */
async function sessionState(controller, sessionId) {
  let items
  try {
    const value = await controller.list({}, signalOf())
    items = Array.isArray(value?.items) ? value.items : []
  } catch {
    return 'unknown'
  }
  const found = items.find((item) => String(item?.sessionId) === sessionId)
  if (!found) return 'missing'
  return found.running === true ? 'running' : 'idle'
}

/* ─────────────────────────────── tools ─────────────────────────────── */

function createSessionTool(ctx) {
  return {
    name: 'session_create',
    description:
      '发起一个新的 Harness 会话（新对话窗口）。可指定工作目录与 agent 预设，返回新会话的 sessionId——该 id 可直接交给 session_inject 使用。',
    parameters: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description:
            '新会话的工作目录绝对路径，须与宿主平台一致（macOS/Linux 如 /home/me/proj，Windows 如 C:\\proj）。省略时使用 Harness 默认工作目录。',
        },
        agentPreset: {
          type: 'string',
          description: '新会话使用的 agent 预设 id（例如预设名）。省略时使用配置的默认预设。',
        },
        title: {
          type: 'string',
          description: '可选：创建后立即设置的会话标题。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          agentPreset: { type: 'string' },
          title: { type: 'string' },
          warning: { type: 'string' },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      render: (args, value) => {
        const lines = [`已创建会话：${value.sessionId}`]
        if (value.agentPreset) lines.push(`预设：${value.agentPreset}`)
        if (value.title) lines.push(`标题：${value.title}`)
        if (value.warning) lines.push(`提示：${value.warning}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const request = {}

      const cwd = nonEmptyString(args.cwd)
      if (cwd) {
        // A relative path would be resolved against the Host process's cwd,
        // which the caller never sees — reject it instead of creating a
        // Session in an unexpected place.
        request.cwd = assertAbsoluteCwd(cwd)
      }

      const agentPreset = nonEmptyString(args.agentPreset)
      if (agentPreset) request.agentPreset = agentPreset

      const controller = controllerOf(ctx)
      const created = await controller.create(request)
      const sessionId = created?.sessionId
      if (!sessionId) {
        throw new Error('session.create 未返回 sessionId，创建未生效。')
      }

      const result = { sessionId: String(sessionId) }
      if (created.agentPreset) result.agentPreset = String(created.agentPreset)

      const title = nonEmptyString(args.title)
      if (title) {
        try {
          const renamed = await controller.rename({ sessionId, title })
          result.title = String(renamed?.title ?? title)
        } catch (error) {
          result.warning = `会话已创建，但设置标题失败：${
            error instanceof Error ? error.message : String(error)
          }`
        }
      }

      return result
    },
  }
}

function createInjectTool(ctx) {
  return {
    name: 'session_inject',
    description:
      '向指定的已有会话投递一条消息（注入）。mode=queue 排队等待该会话下一轮处理；mode=steer 立即引导、在该会话最近一步边界生效。返回 accepted 表示会话已接收该消息。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '目标会话 id（可用 session_list 查询，或 session_create 的返回值）。',
        },
        message: {
          type: 'string',
          description: '要注入的文本内容，不能为空。',
        },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description: 'queue＝排队到下一轮（默认）；steer＝立即引导当前轮。',
        },
      },
      required: ['sessionId', 'message'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          mode: { type: 'string' },
          accepted: { type: 'boolean' },
          requestId: { type: 'string' },
        },
        required: ['sessionId', 'mode', 'accepted'],
        additionalProperties: false,
      },
      render: (args, value) => [
        {
          type: 'text',
          text: `已注入会话 ${value.sessionId}（mode=${value.mode}，accepted=${value.accepted}）。`,
        },
      ],
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const sessionId = nonEmptyString(args.sessionId)
      if (!sessionId) throw new Error('sessionId 不能为空，请先用 session_list 确认目标会话。')

      const message = typeof args.message === 'string' ? args.message : ''
      if (message.trim() === '') throw new Error('message 不能为空。')

      const mode = args.mode === 'steer' ? 'steer' : 'queue'
      const requestId = newRequestId()

      const controller = controllerOf(ctx)
      const admitted = await controller.prompt(
        {
          requestId,
          sessionId,
          mode,
          content: [{ type: 'text', text: message }],
        },
        signalOf(),
      )

      return {
        sessionId,
        mode,
        accepted: admitted?.accepted === true,
        requestId,
      }
    },
  }
}

function createListTool(ctx) {
  return {
    name: 'session_list',
    description:
      '列出当前可见的 Harness 会话（按活跃度排序），用于找到 session_inject 需要的 sessionId。只读存储，不会唤醒冷会话。',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: '最多返回多少条，默认 20，范围 1-100。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          count: { type: 'number' },
          sessions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sessionId: { type: 'string' },
                updatedAt: { type: 'string' },
                running: { type: 'boolean' },
                blank: { type: 'boolean' },
                origin: { type: 'string' },
                cwd: { type: 'string' },
              },
              required: ['sessionId', 'running', 'blank'],
              additionalProperties: false,
            },
          },
        },
        required: ['count', 'sessions'],
        additionalProperties: false,
      },
      render: (args, value) => {
        if (value.count === 0) return [{ type: 'text', text: '（没有可见会话）' }]
        const rows = value.sessions.map((row) => {
          const flags = [row.running ? 'running' : 'idle']
          if (row.blank) flags.push('blank')
          if (row.origin) flags.push(row.origin)
          const tail = row.cwd ? `  ${row.cwd}` : ''
          return `- ${row.sessionId}  [${flags.join(', ')}]  ${row.updatedAt}${tail}`
        })
        return [{ type: 'text', text: `${value.count} 个会话：\n${rows.join('\n')}` }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const rawLimit = Number(args.limit)
      const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(1, Math.trunc(rawLimit))) : 20

      const controller = controllerOf(ctx)
      const value = await controller.list({}, signalOf())
      const items = Array.isArray(value?.items) ? value.items : []

      const sessions = items.slice(0, limit).map((item) => {
        const row = {
          sessionId: String(item.sessionId),
          running: item.running === true,
          blank: item.blank === true,
        }
        if (typeof item.updatedAt === 'number') row.updatedAt = new Date(item.updatedAt).toISOString()
        else row.updatedAt = ''
        if (item.origin) row.origin = String(item.origin)
        if (item.cwd) row.cwd = String(item.cwd)
        return row
      })

      return { count: sessions.length, sessions }
    },
  }
}

function createCancelTool(ctx) {
  return {
    name: 'session_cancel',
    description:
      '取消某个会话当前正在执行的轮次（不丢弃已排队的消息）。用于解救卡在未结算工具调用上的会话：取消后该轮结束，先前排队的注入消息才有机会被消费。会话空闲或不存在时返回 accepted=false 并说明原因（reason=idle / not-found），不会误报为已取消。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: '目标会话 id。',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          accepted: { type: 'boolean' },
          reason: { type: 'string', enum: ['idle', 'not-found'] },
        },
        required: ['sessionId', 'accepted'],
        additionalProperties: false,
      },
      render: (args, value) => [
        {
          type: 'text',
          text: value.accepted
            ? `已请求取消会话 ${value.sessionId} 的当前轮次。`
            : value.reason === 'not-found'
              ? `找不到会话 ${value.sessionId}：它不存在、已被删除，或不属于当前 profile。`
              : `会话 ${value.sessionId} 当前空闲，没有可取消的轮次（已排队的消息不受影响）。`,
        },
      ],
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const sessionId = nonEmptyString(args.sessionId)
      if (!sessionId) throw new Error('sessionId 不能为空。')

      const controller = controllerOf(ctx)

      // `controller.cancel` answers accepted=true even for an idle session and
      // throws for an unknown id, so ask the store first: the useful answer is
      // "there is no turn to cancel", not "request accepted".
      const state = await sessionState(controller, sessionId)
      if (state === 'missing') return { sessionId, accepted: false, reason: 'not-found' }
      if (state === 'idle') return { sessionId, accepted: false, reason: 'idle' }

      try {
        const result = await controller.cancel({ sessionId })
        if (result?.accepted === true) return { sessionId, accepted: true }
        return { sessionId, accepted: false, reason: 'idle' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // Race: the session was removed between the check and the cancel.
        if (/not found|not attached/i.test(message)) return { sessionId, accepted: false, reason: 'not-found' }
        throw error
      }
    },
  }
}

function createStateTool(ctx) {
  return {
    name: 'session_state',
    description:
      '读取一个会话的被动状态：是否正在运行、已排队但未处理的输入条数、正在等待用户处理的交互（审批/提问）。只读，不会唤醒冷会话。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '目标会话 id。' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          running: { type: 'boolean' },
          active: { type: 'boolean' },
          cursor: { type: 'number' },
          queued: { type: 'number' },
          pendingInput: { type: 'array', items: { type: 'string' } },
        },
        required: ['sessionId', 'running', 'active', 'cursor', 'queued'],
        additionalProperties: false,
      },
      render: (args, value) => {
        const parts = [value.running ? 'running' : 'idle']
        if (value.queued > 0) parts.push(`queue=${value.queued}`)
        if (value.pendingInput?.length) parts.push(`pending=${value.pendingInput.join('/')}`)
        return [{ type: 'text', text: `会话 ${value.sessionId}：${parts.join('，')}（cursor=${value.cursor}）` }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const sessionId = nonEmptyString(args.sessionId)
      if (!sessionId) throw new Error('sessionId 不能为空。')

      const controller = controllerOf(ctx)
      let state
      try {
        state = await controller.state({ sessionId }, signalOf())
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/not found|not attached/i.test(message)) {
          throw new Error(`找不到会话 ${sessionId}：它不存在、已被删除，或不属于当前 profile。`)
        }
        throw error
      }

      const queue = Array.isArray(state?.queue) ? state.queue : []
      const pendingInput = Array.isArray(state?.pendingInput) ? state.pendingInput.map(String) : []
      return {
        sessionId,
        running: state?.running === true,
        active: state?.active === true,
        cursor: Number(state?.cursor ?? 0),
        queued: queue.length,
        ...(pendingInput.length ? { pendingInput } : {}),
      }
    },
  }
}

/** Fold one `assistant/message` event into plain text plus its input-token count. */
function assistantFacts(records) {
  let text = ''
  let inputTokens
  for (const record of records) {
    const event = record?.event
    if (!event || event.type !== 'assistant/message') continue
    const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
    const parts = content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text)
    if (parts.length) text = parts.join('\n')
    const usage = event.data?.usage
    if (typeof usage?.inputTokens === 'number') inputTokens = usage.inputTokens
  }
  return { text, inputTokens }
}

function createWaitTool(ctx) {
  return {
    name: 'session_wait',
    description:
      '等待一个会话进入可观察状态：空闲（idle）、等待用户输入（input-required）或超时（timeout），并返回该窗口内助手最新一条消息的文本与本次请求的输入 token 数。用于替代 sleep 轮询——由宿主在事件发生时返回。',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: '目标会话 id。' },
        timeoutMs: {
          type: 'number',
          description: '最长等待毫秒数，默认 60000，范围 1000-600000。',
        },
        afterSeq: {
          type: 'number',
          description: '只看该事件序号之后的记录；省略时从会话当前进度开始。',
        },
        maxMessages: {
          type: 'number',
          description: '最多返回多少条事件记录，默认 200。',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          reason: { type: 'string', enum: ['idle', 'input-required', 'timeout'] },
          running: { type: 'boolean' },
          cursor: { type: 'number' },
          queued: { type: 'number' },
          text: { type: 'string' },
          inputTokens: { type: 'number' },
          truncated: { type: 'boolean' },
        },
        required: ['sessionId', 'reason', 'running', 'truncated'],
        additionalProperties: false,
      },
      render: (args, value) => {
        const lines = [`会话 ${value.sessionId}：${value.reason}（running=${value.running}，cursor=${value.cursor}）`]
        if (value.queued > 0) lines.push(`排队输入：${value.queued}`)
        if (typeof value.inputTokens === 'number') lines.push(`输入 token：${value.inputTokens}`)
        if (value.text) lines.push('', value.text)
        if (value.truncated) lines.push('', `（输出已截断，可提高 maxMessages 后重试）`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const sessionId = nonEmptyString(args.sessionId)
      if (!sessionId) throw new Error('sessionId 不能为空。')

      const request = { sessionId }
      const timeout = Number(args.timeoutMs)
      if (Number.isFinite(timeout)) request.timeoutMs = Math.min(600000, Math.max(1000, Math.trunc(timeout)))
      const afterSeq = Number(args.afterSeq)
      if (Number.isFinite(afterSeq)) request.afterSeq = Math.trunc(afterSeq)
      const maxMessages = Number(args.maxMessages)
      if (Number.isFinite(maxMessages)) request.maxMessages = Math.min(5000, Math.max(1, Math.trunc(maxMessages)))

      const controller = controllerOf(ctx)
      let waited
      try {
        waited = await controller.wait(request, signalOf())
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/not found|not attached/i.test(message)) {
          throw new Error(`找不到会话 ${sessionId}：它不存在、已被删除，或不属于当前 profile。`)
        }
        throw error
      }

      const records = Array.isArray(waited?.output?.records) ? waited.output.records : []
      const { text, inputTokens } = assistantFacts(records)
      const queue = Array.isArray(waited?.state?.queue) ? waited.state.queue : []

      return {
        sessionId,
        reason: waited?.reason ?? 'timeout',
        running: waited?.state?.running === true,
        cursor: Number(waited?.state?.cursor ?? 0),
        queued: queue.length,
        text: text.slice(0, 8000),
        ...(typeof inputTokens === 'number' ? { inputTokens } : {}),
        truncated: waited?.output?.truncated === true,
      }
    },
  }
}

function createSearchTool(ctx) {
  return {
    name: 'session_search',
    description:
      '在所有可见会话的历史里按字面文本检索（不是语义检索），返回命中的会话 id 与上下文片段。用于在不知道 id 时先定位会话。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要检索的字面文本。' },
        limit: { type: 'number', description: '最多返回多少条，默认 10，范围 1-50。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          count: { type: 'number' },
          hasMore: { type: 'boolean' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { sessionId: { type: 'string' }, snippet: { type: 'string' } },
              required: ['sessionId', 'snippet'],
              additionalProperties: false,
            },
          },
        },
        required: ['query', 'count', 'hasMore', 'items'],
        additionalProperties: false,
      },
      render: (args, value) => {
        if (value.count === 0) return [{ type: 'text', text: `没有会话命中「${value.query}」。` }]
        const rows = value.items.map((item) => `- ${item.sessionId}\n  ${item.snippet.replace(/\s+/g, ' ').slice(0, 200)}`)
        const more = value.hasMore ? '\n（还有更多命中，请改用更精确的 query）' : ''
        return [{ type: 'text', text: `${value.count} 个命中：\n${rows.join('\n')}${more}` }]
      },
    },
    async execute(rawArgs) {
      const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {}
      const query = nonEmptyString(args.query)
      if (!query) throw new Error('query 不能为空。')

      const rawLimit = Number(args.limit)
      const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, Math.trunc(rawLimit))) : 10

      const controller = controllerOf(ctx)
      const value = await controller.search({ query }, signalOf())
      const items = (Array.isArray(value?.items) ? value.items : []).slice(0, limit).map((item) => ({
        sessionId: String(item.sessionId),
        snippet: String(item.snippet ?? ''),
      }))
      return { query, count: items.length, hasMore: value?.hasMore === true, items }
    },
  }
}

/* ─────────────────────────────── entry ─────────────────────────────── */

/**
 * Register the session tools.
 * @param ctx Cordis plugin context.
 */
export function apply(ctx) {
  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`${name}: ${message}`)
    } catch {
      /* logging must never break activation */
    }
  }

  const effect = (factory, label) => {
    if (typeof ctx.effect === 'function') return ctx.effect(factory, label)
    return factory()
  }

  if (!ctx.get('sessionController')) {
    warn('sessionController 未组合：工具已注册，但调用会返回不可用错误。')
  }

  for (const tool of [
    createSessionTool(ctx),
    createInjectTool(ctx),
    createListTool(ctx),
    createCancelTool(ctx),
    createStateTool(ctx),
    createWaitTool(ctx),
    createSearchTool(ctx),
  ]) {
    effect(() => ctx.tools.register(tool), `${name}.tool.${tool.name}()`)
  }
}
