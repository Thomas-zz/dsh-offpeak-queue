/**
 * Session-scoped model guidance for a conversation-bound off-peak task.
 *
 * When a task is created for a conversation, one system-prompt section is
 * registered on the owning Agent's scope so the model knows the conversation
 * carries a queued task and must not start it on its own — only an explicit
 * user request to “execute this task” may call `run_current`. The section is
 * disposed when the task settles/cancels or the plugin unloads.
 *
 * @module dsh-offpeak-queue/host/guidance
 */

/** Prompt-section order: before the tool sections, after policy sections. */
const SECTION_ORDER = 680

/**
 * Create the guidance registry.
 *
 * @param {{logger?: {warn: Function}}} [options] - dependencies.
 * @returns {{register: (agent: object, task: object) => boolean, unregister: (taskId: string) => void, disposeAll: () => void, size: () => number}} registry.
 */
export function createGuidance(options = {}) {
  const logger = options.logger ?? console
  /** taskId → exact disposer from `agent.ctx.systemPrompt.section()`. */
  const disposers = new Map()

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
   * Build the guidance text for one task.
   *
   * @param {object} task - created task.
   * @returns {string} system-prompt section text.
   */
  function guidanceText(task) {
    return [
      `本会话关联一个待执行的闲时任务「${task.title}」（任务 id ${task.id}，状态：等待闲时执行）。任务内容会随执行指令一起给出。`,
      '只有当用户明确要求“执行这个任务”时，才调用 offpeak_queue 的 run_current；不要自行开始执行该任务内容。',
      '任务到闲时（或用户点击立即执行）会由宿主自动执行，执行时会在本会话里收到一条开始指令。',
    ].join('')
  }

  /**
   * Register guidance for one created task on its owning Agent scope.
   *
   * @param {object} agent - owning Agent (exposes `ctx.systemPrompt.section`).
   * @param {object} task - created task.
   * @returns {boolean} whether the section was registered.
   */
  function register(agent, task) {
    const systemPrompt = agent?.ctx?.systemPrompt
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return false
    try {
      const dispose = systemPrompt.section({
        name: `offpeak-task-${task.id}`,
        order: SECTION_ORDER,
        text: guidanceText(task),
      })
      const previous = disposers.get(task.id)
      if (previous !== undefined) {
        disposers.delete(task.id)
        try {
          previous()
        } catch {
          /* ignored */
        }
      }
      disposers.set(task.id, () => {
        try {
          dispose()
        } catch (error) {
          warn(`offpeak-queue: 移除任务指引失败：${error instanceof Error ? error.message : String(error)}`)
        }
      })
      return true
    } catch (error) {
      warn(`offpeak-queue: 注册任务指引失败：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  /**
   * Dispose guidance for one task (idempotent).
   *
   * @param {string} taskId - task id.
   * @returns {void}
   */
  function unregister(taskId) {
    const dispose = disposers.get(taskId)
    if (dispose === undefined) return
    disposers.delete(taskId)
    dispose()
  }

  /**
   * Dispose every registered guidance (plugin unload).
   *
   * @returns {void}
   */
  function disposeAll() {
    for (const taskId of [...disposers.keys()]) unregister(taskId)
  }

  return { register, unregister, disposeAll, size: () => disposers.size }
}

/**
 * Build the guidance text for one task (exported for tests).
 *
 * @param {object} task - created task.
 * @returns {string} system-prompt section text.
 */
export function taskGuidanceText(task) {
  return [
    `本会话关联一个待执行的闲时任务「${task.title}」（任务 id ${task.id}，状态：等待闲时执行）。任务内容会随执行指令一起给出。`,
    '只有当用户明确要求“执行这个任务”时，才调用 offpeak_queue 的 run_current；不要自行开始执行该任务内容。',
    '任务到闲时（或用户点击立即执行）会由宿主自动执行，执行时会在本会话里收到一条开始指令。',
  ].join('')
}
