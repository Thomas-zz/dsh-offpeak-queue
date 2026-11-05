/**
 * Zero-call creation interception.
 *
 * A conversation armed through `POST /sessions/:id/arm` is a pending off-peak
 * task creation session: the user types the task description and presses
 * Enter, and this global `agent/pre-step` listener claims that message as the
 * task, disarms the session, renames the conversation, and answers
 * `{kind:'reject'}`. The Agent loop then closes the turn as `blocked` with
 * **no model request** (`turn/start` was already appended, so the session is
 * non-blank and visible in its workspace).
 *
 * A rejected step never writes the claimed message to the session log, and the
 * plugin must not write it either: the format requires the first model-visible
 * event of a log to be a protected `system/message`, which only the Agent loop
 * emits (inside `step()`). Writing a `user/message` first leaves a structurally
 * corrupt log that fails to load on the next launch. The task content is kept
 * on the task record and replayed with the execution instruction instead.
 *
 * @module dsh-offpeak-queue/host/prestep
 */

import { titleFromPrompt } from './store.js'

/** Labels of the default creation template; a message made only of these is not a task. */
export const TEMPLATE_LABELS = Object.freeze([
  '请描述要在闲时执行的任务',
  '任务目标',
  '验收标准',
  '输出要求',
  '相关文件或目录',
])

/** Error shown on the dock when the submitted description is empty or template-only. */
export const EMPTY_DESCRIPTION_ERROR = '任务描述不能为空'

/** Task-title characters kept in the renamed conversation title. */
const RENAME_TITLE_CHARS = 40

/**
 * Extract the claimed inbox text from one pre-step payload.
 *
 * `payload.messages` holds only the claimed user messages; runtime context is
 * contributed later by other listeners through `next()`, so this never
 * captures injected context.
 *
 * @param {unknown} messages - claimed inbox messages.
 * @returns {string} joined text, trimmed.
 */
export function extractTaskText(messages) {
  if (!Array.isArray(messages)) return ''
  const parts = []
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : []
    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    if (text.trim() !== '') parts.push(text.trim())
  }
  return parts.join('\n\n').trim()
}

/**
 * Validate one submitted task description.
 *
 * @param {string} text - extracted text.
 * @returns {string|null} a Chinese error message, or null when valid.
 */
export function validateTaskText(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return EMPTY_DESCRIPTION_ERROR
  // Strip the template labels wherever they appear, then punctuation and
  // whitespace: a description made only of labels is not a task.
  let stripped = trimmed
  for (const label of TEMPLATE_LABELS) stripped = stripped.split(label).join('')
  const meaningful = stripped
    .replace(/[：:，,。.、；;！!？?（）()【】[\]{} \t\r\n\-—_/\\|“”"'']/g, '')
    .trim()
  if (meaningful === '') return EMPTY_DESCRIPTION_ERROR
  return null
}

/**
 * Collect the durable content blocks of the claimed creation messages.
 *
 * A rejected step never reaches `Session#append`, so the plugin cannot write
 * the creation message into the log itself: the session-format contract
 * requires the first model-visible node to be a protected `system/message`,
 * and only the Agent loop writes that (it does so inside `step()`, which a
 * rejected step never enters). Appending a bare `user/message` first makes the
 * stored log unreadable on the next launch ("system/message requires a
 * protected first surface head"), so the task content travels with the
 * execution instruction instead — see `EXECUTION_MESSAGE` in `runner.js`.
 *
 * Text and attachment blocks are kept verbatim so screenshots pasted into the
 * creation composer still reach the model at execution time.
 *
 * @param {unknown[]} messages - claimed inbox messages.
 * @returns {object[]} content blocks (text/image/file) in submission order.
 */
export function extractTaskContent(messages) {
  const content = []
  if (!Array.isArray(messages)) return content
  for (const message of messages) {
    const blocks = Array.isArray(message?.content) ? message.content : []
    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue
      if (block.type === 'text' && typeof block.text === 'string') {
        if (block.text.trim() !== '') content.push({ type: 'text', text: block.text })
        continue
      }
      if (block.type === 'image' || block.type === 'file') content.push(block)
    }
  }
  return content
}

/**
 * Create the pre-step creation listener.
 *
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   store: ReturnType<typeof import('./store.js').createStore>,
 *   guidance: ReturnType<typeof import('./guidance.js').createGuidance>,
 *   controller: {createTaskFromCreation: Function},
 *   logger?: {warn: Function, info: Function},
 *   now?: () => number,
 * }} options - listener dependencies.
 * @returns {{handle: Function, install: () => () => void}} listener API.
 */
export function createPrestep(options) {
  const { ctx, store, guidance, controller } = options
  const logger = options.logger ?? console

  /**
   * Log a warning without throwing.
   *
   * @param {string} message - text.
   * @returns {void}
   */
  function warn(message) {
    try {
      logger.warn(message)
    } catch {
      /* ignored */
    }
  }

  /**
   * Rename the creation conversation so it is recognizable in the workspace
   * list. Best effort: a title failure never fails the creation.
   *
   * @param {object} session - live session.
   * @param {string} title - task title.
   * @returns {void}
   */
  function renameSession(session, title) {
    try {
      const titles = ctx.get('sessionTitle')
      if (titles === undefined || typeof titles.rename !== 'function') return
      const short = String(title).length > RENAME_TITLE_CHARS
        ? `${String(title).slice(0, RENAME_TITLE_CHARS - 1)}…`
        : String(title)
      titles.rename(session, `闲时任务 · ${short}`)
    } catch (error) {
      warn(`offpeak-queue: 设置创建会话标题失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * The global `agent/pre-step` waterfall listener.
   *
   * @param {object} payload - waterfall payload (`agent`, `messages`, …).
   * @param {Function} next - continuation returning the enter decision.
   * @returns {Promise<object>} enter decision or `{kind:'reject'}`.
   */
  async function handle(payload, next) {
    const agent = payload?.agent
    const session = agent?.session
    const sessionId = typeof session?.id === 'string' ? session.id : null
    if (sessionId === null) return next()
    const armed = store.getArmed(sessionId)
    if (armed === null) return next()

    let text
    let invalid
    try {
      text = extractTaskText(payload.messages)
      invalid = validateTaskText(text)
    } catch (error) {
      warn(`offpeak-queue: 读取创建消息失败：${error instanceof Error ? error.message : String(error)}`)
      try {
        store.setArmError(sessionId, '读取任务描述失败，请重新输入')
      } catch {
        /* ignored */
      }
      return next()
    }

    // Invalid description: keep the session armed, surface the error on the
    // dock, and reject the step (no model request). Nothing is written to the
    // session log here — see {@link extractTaskContent} for why.
    if (invalid !== null) {
      store.setArmError(sessionId, invalid)
      return { kind: 'reject' }
    }

    // Edit mode: the armed conversation updates the queued task in place. The
    // new text and its attachments replace the stored task content, and the
    // turn is rejected without a model call.
    if (armed.mode === 'update' && typeof armed.taskId === 'string') {
      let updated
      try {
        updated = controller.updateTaskFromCreation({
          sessionId,
          taskId: armed.taskId,
          text,
          title: titleFromPrompt(text),
          content: extractTaskContent(payload.messages),
        })
      } catch (error) {
        warn(`offpeak-queue: 更新闲时任务失败：${error instanceof Error ? error.message : String(error)}`)
        try {
          store.setArmError(sessionId, `更新闲时任务失败：${error instanceof Error ? error.message : String(error)}`)
        } catch {
          /* ignored */
        }
        return next()
      }
      if (updated === null || updated === undefined) {
        store.setArmError(sessionId, '更新闲时任务失败，请重试')
        return next()
      }
      guidance.register(agent, updated)
      return { kind: 'reject' }
    }

    // Create the task FIRST: on any failure the loop must run the normal turn,
    // which appends the claimed message itself — writing it here too would
    // duplicate it in the transcript and model history.
    let created
    try {
      created = controller.createTaskFromCreation({
        sessionId,
        workspaceId: armed.workspaceId,
        text,
        title: titleFromPrompt(text),
        cwd: typeof session.header?.cwd === 'string' ? session.header.cwd : '',
        content: extractTaskContent(payload.messages),
      })
    } catch (error) {
      warn(`offpeak-queue: 创建闲时任务失败：${error instanceof Error ? error.message : String(error)}`)
      try {
        store.setArmError(sessionId, `创建闲时任务失败：${error instanceof Error ? error.message : String(error)}`)
      } catch {
        /* ignored */
      }
      return next()
    }
    if (created === null || created === undefined) {
      store.setArmError(sessionId, '创建闲时任务失败，请重试')
      return next()
    }

    // Success: rename the conversation and register the session guidance. The
    // task text itself is stored on the task record and replayed with the
    // execution instruction.
    renameSession(session, created.title)
    guidance.register(agent, created)
    return { kind: 'reject' }
  }

  /**
   * Install the listener on the Host context.
   *
   * @returns {() => void} exact disposer.
   */
  function install() {
    return ctx.on('agent/pre-step', handle)
  }

  return { handle, install }
}
