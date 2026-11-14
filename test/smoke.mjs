/**
 * Smoke test for dsh-agent-session-tools, runnable without installing it.
 *
 * It imports the real plugin module and drives `apply()` with a fake Cordis
 * context and a stubbed `sessionController`, so registration shape and every
 * execute() path are exercised before anything touches a live profile.
 *
 * Run: node test/smoke.mjs
 */

import { apply, inject, name } from '../index.js'

const isWindows = process.platform === 'win32'

/** A path that is really absolute on the platform running this test. */
const ABS_CWD = isWindows ? 'C:\\proj' : '/home/me/proj'

/** Absolute on the *other* platform: rejected on POSIX, ordinary on Windows. */
const FOREIGN_CWD = isWindows ? '/home/me/proj' : 'C:\\proj'

/** Sample cwd carried through session_list, in host style. */
const SAMPLE_CWD = isWindows ? 'C:\\work\\a' : '/work/a'

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Flatten a tool's output.render() result to plain text, as the Host does. */
function renderText(tool, value) {
  return tool.output
    .render({}, value)
    .map((part) => part.text)
    .join('\n')
}

function callRecord() {
  return { create: [], prompt: [], list: [], rename: [], cancel: [], state: [], wait: [], search: [] }
}

function makeCtx(calls, overrides = {}) {
  const registered = []
  const controller = {
    async create(request) {
      calls.create.push(request)
      return { sessionId: 'session-test-1', agentPreset: request.agentPreset }
    },
    async prompt(request) {
      calls.prompt.push(request)
      return { accepted: true }
    },
    async list() {
      calls.list.push(true)
      return {
        items: [
          { sessionId: 's-a', updatedAt: 1700000000000, running: true, blank: false, cwd: SAMPLE_CWD },
          { sessionId: 's-b', updatedAt: 1700000001000, running: false, blank: true, origin: 'subagent' },
        ],
      }
    },
    async rename(request) {
      calls.rename.push(request)
      return { title: request.title, seq: 1 }
    },
    async cancel(request) {
      calls.cancel.push(request)
      return { accepted: true }
    },
    async state(request) {
      calls.state.push(request)
      return {
        cursor: 42,
        active: true,
        running: false,
        queue: [{ id: 'q1', placement: 'queued', content: [] }, { id: 'q2', placement: 'steering', content: [] }],
        pendingInput: ['approval'],
      }
    },
    async wait(request) {
      calls.wait.push(request)
      return {
        reason: 'idle',
        state: { cursor: 77, active: true, running: false, queue: [], pendingInput: [] },
        output: {
          records: [
            {
              type: 'event',
              event: {
                type: 'assistant/message',
                seq: 77,
                time: 2,
                data: {
                  message: { role: 'assistant', content: [{ type: 'text', text: 'DONE' }, { type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }] },
                  usage: { inputTokens: 1234 },
                },
              },
            },
            { type: 'event', event: { type: 'turn/end', seq: 78, time: 3, data: { kind: 'completed' } } },
          ],
          truncated: false,
        },
      }
    },
    async search(request) {
      calls.search.push(request)
      return {
        items: [
          { sessionId: 's-a', snippet: 'hit one' },
          { sessionId: 's-b', snippet: 'hit two' },
        ],
        hasMore: true,
      }
    },
    ...overrides,
  }

  const ctx = {
    get: (key) => (key === 'sessionController' ? controller : undefined),
    effect: (factory) => factory(),
    logger: { warn: () => {} },
    tools: {
      register: (tool) => {
        registered.push(tool)
        return () => {}
      },
    },
  }
  return { ctx, registered }
}

const calls = callRecord()
const { ctx, registered } = makeCtx(calls)

console.log('— module shape —')
check('exports name', name === 'dsh-agent-session-tools')
check('inject waits for tools', Array.isArray(inject) && inject.includes('tools'))
check('apply is a function', typeof apply === 'function')

console.log('— registration —')
apply(ctx)
check('registers seven tools', registered.length === 7, `got ${registered.length}`)

const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]))
check('session_create registered', Boolean(byName.session_create))
check('session_inject registered', Boolean(byName.session_inject))
check('session_list registered', Boolean(byName.session_list))
check('session_cancel registered', Boolean(byName.session_cancel))
check('session_state registered', Boolean(byName.session_state))
check('session_wait registered', Boolean(byName.session_wait))
check('session_search registered', Boolean(byName.session_search))

for (const tool of registered) {
  check(`${tool.name}: has description`, typeof tool.description === 'string' && tool.description.length > 10)
  check(
    `${tool.name}: parameters is an object schema`,
    tool.parameters?.type === 'object' && typeof tool.parameters.properties === 'object',
  )
  check(`${tool.name}: execute is a function`, typeof tool.execute === 'function')
  check(`${tool.name}: output render present`, typeof tool.output?.render === 'function')
}

console.log('— session_create —')
{
  const result = await byName.session_create.execute({ cwd: `  ${ABS_CWD}  `, agentPreset: 'preset-x', title: 'T1' })
  const request = calls.create.at(-1)
  check('returns sessionId', result.sessionId === 'session-test-1')
  check('trims cwd', request.cwd === ABS_CWD)
  check('passes agentPreset', request.agentPreset === 'preset-x')
  check('echoes agentPreset', result.agentPreset === 'preset-x')
  check('applies title via rename', calls.rename.at(-1)?.title === 'T1')
  check('reports title', result.title === 'T1')
}

console.log('— session_create: empty args —')
{
  const before = calls.create.length
  const result = await byName.session_create.execute({})
  check('sends an empty request', JSON.stringify(calls.create.at(-1)) === '{}')
  check('still returns a sessionId', result.sessionId === 'session-test-1')
  check('one create call recorded', calls.create.length === before + 1)
}

console.log('— session_create: rejects a relative cwd —')
{
  const before = calls.create.length
  let message = ''
  try {
    await byName.session_create.execute({ cwd: 'relative/dir' })
  } catch (error) {
    message = String(error.message)
  }
  check('rejects relative cwd', message.includes('绝对路径'), message || 'no error thrown')
  check('no create call on rejection', calls.create.length === before)
}

console.log('— session_create: cwd style must match the host —')
{
  const before = calls.create.length
  let message = ''
  try {
    await byName.session_create.execute({ cwd: FOREIGN_CWD })
  } catch (error) {
    message = String(error.message)
  }
  if (isWindows) {
    // POSIX-style paths are absolute on Windows too, so this is simply accepted.
    check('POSIX path accepted on Windows', calls.create.length === before + 1, message || 'no create call')
  } else {
    check('rejects a Windows path on POSIX', message.includes('Windows 绝对路径'), message || 'no error thrown')
    check('names the host platform', message.includes(`当前 Host 运行在 ${process.platform}`), message)
    check('no create call on rejection', calls.create.length === before)
  }
}

console.log('— session_create: accepts a POSIX absolute cwd —')
{
  await byName.session_create.execute({ cwd: '/home/me/proj' })
  check('passes POSIX absolute path', calls.create.at(-1)?.cwd === '/home/me/proj')
}

console.log('— session_create: title failure is non-fatal —')
{
  const failing = callRecord()
  const { ctx: badCtx } = makeCtx(failing, {
    async rename() {
      throw new Error('rename boom')
    },
  })
  const tools = []
  badCtx.tools.register = (tool) => {
    tools.push(tool)
    return () => {}
  }
  apply(badCtx)
  const createTool = tools.find((tool) => tool.name === 'session_create')
  const result = await createTool.execute({ title: 'nope' })
  check('session still created', result.sessionId === 'session-test-1')
  check('warning surfaced', typeof result.warning === 'string' && result.warning.includes('rename boom'))
}

console.log('— session_inject —')
{
  const result = await byName.session_inject.execute({ sessionId: 's-target', message: '你好' })
  const request = calls.prompt.at(-1)
  check('accepted', result.accepted === true)
  check('defaults to queue', request.mode === 'queue')
  check('routes to the session', request.sessionId === 's-target')
  check('sends one text block', request.content?.[0]?.type === 'text' && request.content[0].text === '你好')
  check(
    'mints a requestId',
    typeof request.requestId === 'string' && request.requestId.startsWith('dsh-agent-session-tools-'),
  )
  check('echoes mode', result.mode === 'queue')
}

console.log('— session_inject: steer —')
{
  const result = await byName.session_inject.execute({ sessionId: 's-target', message: '改方向', mode: 'steer' })
  check('mode honours steer', calls.prompt.at(-1).mode === 'steer')
  check('result mode steer', result.mode === 'steer')
}

console.log('— session_inject: rejects bad input —')
{
  const before = calls.prompt.length
  let emptyMessage = false
  try {
    await byName.session_inject.execute({ sessionId: 's', message: '   ' })
  } catch {
    emptyMessage = true
  }
  check('rejects blank message', emptyMessage)

  let missingSession = false
  try {
    await byName.session_inject.execute({ message: 'x' })
  } catch {
    missingSession = true
  }
  check('rejects missing sessionId', missingSession)
  check('no prompt sent on rejection', calls.prompt.length === before)
}

console.log('— requestId uniqueness —')
{
  const ids = []
  for (let i = 0; i < 5; i += 1) {
    await byName.session_inject.execute({ sessionId: 's', message: `m${i}` })
    ids.push(calls.prompt.at(-1).requestId)
  }
  check('all requestIds distinct', new Set(ids).size === ids.length)
}

console.log('— session_list —')
{
  const result = await byName.session_list.execute({ limit: 1 })
  check('honours limit', result.count === 1 && result.sessions.length === 1)
  check('maps updatedAt to ISO', /^\d{4}-\d{2}-\d{2}T/.test(result.sessions[0].updatedAt))
  check('keeps cwd', result.sessions[0].cwd === SAMPLE_CWD)

  const all = await byName.session_list.execute({})
  check('defaults to every row', all.count === 2)
  check('keeps origin', all.sessions.some((row) => row.origin === 'subagent'))
}

console.log('— session_cancel: running session —')
{
  const before = calls.cancel.length
  const result = await byName.session_cancel.execute({ sessionId: 's-a' })
  check('accepted', result.accepted === true)
  check('routes to the session', calls.cancel.at(-1)?.sessionId === 's-a')
  check('calls the controller once', calls.cancel.length === before + 1)
  check('renders the accepted branch', renderText(byName.session_cancel, result).includes('已请求取消'))
}

console.log('— session_cancel: idle session is not a cancel —')
{
  const before = calls.cancel.length
  const result = await byName.session_cancel.execute({ sessionId: 's-b' })
  check('accepted is false', result.accepted === false)
  check('reason is idle', result.reason === 'idle')
  check('does not touch the controller', calls.cancel.length === before)
  check('render says idle', renderText(byName.session_cancel, result).includes('空闲'))
}

console.log('— session_cancel: unknown session —')
{
  const before = calls.cancel.length
  const result = await byName.session_cancel.execute({ sessionId: 'session-does-not-exist' })
  check('accepted is false', result.accepted === false)
  check('reason is not-found', result.reason === 'not-found')
  check('does not touch the controller', calls.cancel.length === before)
  check('render says not found', renderText(byName.session_cancel, result).includes('找不到会话'))
}

console.log('— session_cancel: unreadable store falls through —')
{
  const fallbackCalls = callRecord()
  const { ctx: noListCtx } = makeCtx(fallbackCalls, {
    async list() {
      throw new Error('list boom')
    },
  })
  const tools = []
  noListCtx.tools.register = (tool) => {
    tools.push(tool)
    return () => {}
  }
  apply(noListCtx)
  const tool = tools.find((entry) => entry.name === 'session_cancel')
  const result = await tool.execute({ sessionId: 's-x' })
  check('falls back to the controller', result.accepted === true && fallbackCalls.cancel.length === 1)
}

console.log('— session_cancel: rejects missing sessionId —')
{
  const before = calls.cancel.length
  let missing = false
  try {
    await byName.session_cancel.execute({})
  } catch {
    missing = true
  }
  check('rejects missing sessionId', missing)
  check('no cancel call on rejection', calls.cancel.length === before)
}

console.log('— missing service —')
{
  const bare = { effect: (f) => f(), logger: { warn: () => {} }, get: () => undefined, tools: { register: () => () => {} } }
  apply(bare)
  const tools = []
  const bareCtx = { ...bare, tools: { register: (tool) => (tools.push(tool), () => {}) } }
  apply(bareCtx)
  let message = ''
  try {
    await tools.find((tool) => tool.name === 'session_list').execute({})
  } catch (error) {
    message = String(error.message)
  }
  check('fails with actionable error', message.includes('sessionController'), message)
}


console.log('— session_state —')
{
  const before = calls.state.length
  const result = await byName.session_state.execute({ sessionId: 's-a' })
  check('one state call', calls.state.length === before + 1)
  check('passes sessionId', calls.state.at(-1).sessionId === 's-a')
  check('reports not running', result.running === false)
  check('counts queued inputs', result.queued === 2)
  check('surfaces pending input', result.pendingInput?.[0] === 'approval')
  check('reports cursor', result.cursor === 42)
  check('renders state', renderText(byName.session_state, result).includes('queue=2'))
  let rejected = false
  try {
    await byName.session_state.execute({})
  } catch {
    rejected = true
  }
  check('rejects missing sessionId', rejected)
}

console.log('— session_state: unknown session —')
{
  const notFoundCalls = callRecord()
  const { ctx: nfCtx } = makeCtx(notFoundCalls, {
    async state() {
      throw new Error('session "nope" not found (not attached)')
    },
  })
  const tools = []
  apply({ ...nfCtx, tools: { register: (tool) => (tools.push(tool), () => {}) } })
  let message = ''
  try {
    await tools.find((tool) => tool.name === 'session_state').execute({ sessionId: 'nope' })
  } catch (error) {
    message = String(error.message)
  }
  check('maps not-found to an actionable message', message.includes('找不到会话 nope'), message)
}

console.log('— session_wait —')
{
  const before = calls.wait.length
  const result = await byName.session_wait.execute({ sessionId: 's-a', timeoutMs: 1500, afterSeq: 10, maxMessages: 50 })
  const request = calls.wait.at(-1)
  check('one wait call', calls.wait.length === before + 1)
  check('passes sessionId', request.sessionId === 's-a')
  check('passes timeoutMs', request.timeoutMs === 1500)
  check('passes afterSeq', request.afterSeq === 10)
  check('passes maxMessages', request.maxMessages === 50)
  check('reports reason', result.reason === 'idle')
  check('reports running=false', result.running === false)
  check('extracts assistant text only', result.text === 'DONE', result.text)
  check('reports input tokens', result.inputTokens === 1234)
  check('reports truncation', result.truncated === false)
  check('renders text', renderText(byName.session_wait, result).includes('DONE'))
}

console.log('— session_wait: clamping —')
{
  await byName.session_wait.execute({ sessionId: 's-a', timeoutMs: 1, maxMessages: 100000 })
  const request = calls.wait.at(-1)
  check('clamps timeoutMs low', request.timeoutMs === 1000, String(request.timeoutMs))
  check('clamps maxMessages high', request.maxMessages === 5000, String(request.maxMessages))
}

console.log('— session_search —')
{
  const before = calls.search.length
  const result = await byName.session_search.execute({ query: '  鹈鹕  ', limit: 1 })
  check('one search call', calls.search.length === before + 1)
  check('trims query', calls.search.at(-1).query === '鹈鹕')
  check('limits items', result.count === 1)
  check('reports hasMore', result.hasMore === true)
  check('renders hits', renderText(byName.session_search, result).includes('s-a'))
  let rejected = false
  try {
    await byName.session_search.execute({ query: '   ' })
  } catch {
    rejected = true
  }
  check('rejects blank query', rejected)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
