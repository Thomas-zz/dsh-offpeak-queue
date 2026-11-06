/**
 * The model-facing `offpeak_queue` tool (v2).
 *
 * Registered process-globally so any agent can manage the off-peak queue and
 * execute a conversation-bound task. It only mutates the persisted queue and
 * asks the engine to start a run — it never creates a session itself and never
 * touches the network. User mistakes surface as readable Chinese `isError`
 * tool results.
 *
 * @module dsh-offpeak-queue/host/tool
 */

import { formatRule } from './policy.js'
import { familyLabel, validFamily } from './families.js'

/** Tool name registered on `ctx.tools`. */
export const TOOL_NAME = 'offpeak_queue'

/** Actions the tool accepts. */
const ACTIONS = ['add', 'list', 'update', 'cancel', 'retry', 'run_now', 'run_current', 'delete']

/** Maximum number of tasks rendered by `list`. */
const LIST_LIMIT = 20

/** Chinese status labels. */
const STATUS_LABEL = {
  queued: '等待',
  running: '执行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** Chinese labels for the derived billing reason. */
const REASON_LABEL = {
  weekend: '周末',
  holiday: '法定节假日',
  'peak-window': '高峰时段',
  'offpeak-window': '闲时时段',
}

/**
 * Wall-clock parts of one instant in a time zone.
 *
 * @param {number} ms - epoch milliseconds.
 * @param {string} timeZone - IANA zone.
 * @returns {{dateKey: string, year: number, month: number, day: number, hour: string, minute: string}} parts.
 */
function wallParts(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const values = {}
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value
  }
  const year = Number(values.year)
  const month = Number(values.month)
  const day = Number(values.day)
  return {
    year,
    month,
    day,
    hour: String(values.hour).padStart(2, '0'),
    minute: String(values.minute).padStart(2, '0'),
    dateKey: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  }
}

/**
 * Format an instant for Chinese chat output, using 今天/明天 where natural.
 *
 * @param {number} ms - epoch milliseconds.
 * @param {string} timeZone - IANA zone.
 * @param {number} nowMs - reference instant.
 * @returns {string} formatted instant.
 */
function formatInstant(ms, timeZone, nowMs) {
  if (!Number.isFinite(ms)) return '待排期'
  const target = wallParts(ms, timeZone)
  const current = wallParts(nowMs, timeZone)
  const targetDay = Date.UTC(target.year, target.month - 1, target.day)
  const currentDay = Date.UTC(current.year, current.month - 1, current.day)
  const dayDelta = Math.round((targetDay - currentDay) / 86_400_000)
  const clock = `${target.hour}:${target.minute}`
  if (dayDelta === 0) return `今天 ${clock}`
  if (dayDelta === 1) return `明天 ${clock}`
  if (dayDelta === 2) return `后天 ${clock}`
  return `${target.dateKey} ${clock}`
}

/**
 * Short prompt preview for the list table.
 *
 * @param {object} task - queue task.
 * @returns {string} single-line preview.
 */
function preview(task) {
  const text = String(task.prompt ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= 48 ? text : `${text.slice(0, 47)}…`
}

/**
 * Render the queue summary as a markdown table.
 *
 * @param {object} summary - controller.listSummary() result.
 * @param {string|null} callingSessionId - session id of the tool caller (marks 本会话 tasks).
 * @returns {string} markdown text.
 */
function renderList(summary, callingSessionId) {
  const { period, periods, families, settings, counts, tasks, now } = summary
  const lines = []
  const visible = Array.isArray(families)
    ? families.filter((family) => family.enabled === true)
    : [{ id: 'deepseek', label: 'DeepSeek' }]
  const periodOf = (familyId) => (periods && periods[familyId] !== undefined ? periods[familyId] : familyId === 'deepseek' ? period : undefined)
  for (const family of visible) {
    const familyPeriod = periodOf(family.id)
    if (familyPeriod === undefined) continue
    if (familyPeriod.kind === 'offpeak') {
      lines.push(`${family.label} 当前：闲时（优惠价）· ${REASON_LABEL[familyPeriod.reason] ?? ''}，下一个高峰 ${formatInstant(familyPeriod.nextChangeAt, settings.timeZone, now)}`)
    } else {
      lines.push(`${family.label} 当前：高峰（全价），下一个闲时 ${formatInstant(familyPeriod.nextOffpeakAt, settings.timeZone, now)} 起`)
    }
  }
  lines.push(`共 ${counts.total} 个任务：等待 ${counts.queued} · 执行中 ${counts.running} · 已完成 ${counts.done} · 失败 ${counts.failed} · 已取消 ${counts.cancelled}`)
  if (tasks.length === 0) {
    lines.push('队列为空。可在闲时任务面板里新建闲时任务，或把这个对话里的任务交给闲时队列。')
    return lines.join('\n')
  }
  lines.push('')
  lines.push('| 状态 | 模型 | 标题 | 时间 | 任务 id |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const task of tasks) {
    let when = ''
    if (task.status === 'queued') when = task.nextRunAt === null ? '待排期' : `${formatInstant(task.nextRunAt, settings.timeZone, now)} 预计开始`
    else if (task.status === 'running') when = task.startedAt === null ? '执行中' : `${formatInstant(task.startedAt, settings.timeZone, now)} 开始`
    else if (task.finishedAt !== null) when = `${formatInstant(task.finishedAt, settings.timeZone, now)} 结束`
    const mine = callingSessionId !== null && task.sourceSessionId === callingSessionId ? '（本会话）' : ''
    const title = `${String(task.title ?? '')}${mine}`.replace(/\|/g, '\\|')
    lines.push(`| ${STATUS_LABEL[task.status] ?? task.status} | ${familyLabel(validFamily(task.modelFamily))} | ${title}（${preview(task)}） | ${when} | \`${task.id}\` |`)
  }
  if (counts.total > tasks.length) lines.push('', `（仅显示最相关的 ${tasks.length} 个任务）`)
  lines.push('', `计费规则：${formatRule(settings)}`)
  return lines.join('\n')
}

/**
 * Compose the markdown for one tool call.
 *
 * @param {object} args - validated tool arguments.
 * @param {object} controller - queue controller.
 * @param {object|undefined} agent - calling Agent (for session binding and guidance).
 * @param {object} guidance - session guidance registry.
 * @returns {Promise<string>} markdown response.
 * @throws {Error} readable Chinese error for user mistakes.
 */
async function runAction(args, controller, agent, guidance) {
  const action = args.action
  const sessionId = typeof agent?.session?.id === 'string' ? agent.session.id : null
  const requireId = () => {
    if (typeof args.id !== 'string' || args.id.trim() === '') throw new Error(`${action} 操作需要提供任务 id`)
    return args.id.trim()
  }
  switch (action) {
    case 'add': {
      // The billing family follows the calling conversation's resolved model
      // route, so the queue schedules the task on that family's calendar.
      const currentSelection = typeof agent?.model?.current === 'function' ? agent.model.current() : undefined
      const result = controller.addTaskFromTool(sessionId, {
        title: args.title,
        prompt: args.prompt,
        cwd: args.cwd,
        modelSelection: {
          provider: typeof currentSelection?.provider === 'string' ? currentSelection.provider : undefined,
          model: typeof currentSelection?.model === 'string' ? currentSelection.model : undefined,
        },
      })
      const task = result.task
      if (agent !== undefined) guidance.register(agent, task)
      const summary = controller.listSummary(500)
      const current = summary.tasks.find((entry) => entry.id === task.id)
      const family = familyLabel(validFamily(task.modelFamily))
      const lines = []
      if (current === undefined) {
        lines.push('已加入闲时队列。')
      } else if (current.status === 'running') {
        lines.push('已加入闲时队列，任务已开始执行。')
      } else if (current.status === 'queued') {
        const queued = summary.tasks.filter((entry) => entry.status === 'queued')
        const position = queued.findIndex((entry) => entry.id === task.id) + 1
        if (position >= 1) {
          const when = formatInstant(queued[position - 1].nextRunAt, summary.settings.timeZone, summary.now)
          lines.push(`已加入闲时队列（${family}，第 ${position} 个），预计 ${when} 闲时开始后自动执行。`)
        } else {
          lines.push(`已加入闲时队列（${family}）。`)
        }
      } else {
        lines.push(`已加入闲时队列，任务已结束（${STATUS_LABEL[current.status] ?? current.status}）。`)
      }
      lines.push(
        `标题：${task.title}`,
        `模型：${family}`,
        `任务 id：\`${task.id}\`（可用 list 查看，或用 cancel 取消）`,
        `计费规则：${formatRule(summary.settings)}`,
      )
      return lines.join('\n')
    }
    case 'list':
      return renderList(controller.listSummary(LIST_LIMIT), sessionId)
    case 'update': {
      const patch = {}
      if (args.title !== undefined) patch.title = args.title
      if (args.prompt !== undefined) patch.prompt = args.prompt
      const result = controller.updateTask(requireId(), patch)
      return `已更新任务「${result.task.title}」（\`${result.task.id}\`）。`
    }
    case 'cancel': {
      const result = controller.cancel(requireId())
      return `已取消任务「${result.task.title}」（\`${result.task.id}\`）。`
    }
    case 'retry': {
      const result = controller.retry(requireId())
      return `已重新加入队列任务「${result.task.title}」（\`${result.task.id}\`），将在闲时自动执行。`
    }
    case 'run_now': {
      const result = await controller.startTask(requireId())
      if (result.task.status === 'failed') {
        throw new Error(`任务开始执行失败：${result.task.error ?? '未知原因'}`)
      }
      return `已开始执行任务「${result.task.title}」（\`${result.task.id}\`），执行过程在该任务的来源对话里继续。`
    }
    case 'run_current': {
      if (sessionId === null) throw new Error('run_current 需要在会话中调用')
      const summary = controller.listSummary(500)
      const bound = summary.tasks.filter((task) => task.sourceSessionId === sessionId)
      const queued = bound.find((task) => task.status === 'queued')
      if (queued === undefined) {
        const running = bound.find((task) => task.status === 'running')
        if (running !== undefined) throw new Error(`本会话的闲时任务「${running.title}」正在执行中`)
        throw new Error('本会话没有等待执行的闲时任务')
      }
      // We are inside this conversation's own turn: queue the execution prompt
      // for the next turn boundary instead of waiting for the current turn.
      const result = await controller.startTask(queued.id, { waitForIdle: false })
      if (result.task.status === 'failed') {
        throw new Error(`任务开始执行失败：${result.task.error ?? '未知原因'}`)
      }
      return `已开始执行本会话的闲时任务「${result.task.title}」，将在本条回复结束后继续。`
    }
    case 'delete': {
      const result = controller.remove(requireId())
      return result.deleted ? '已删除任务。' : '任务不存在。'
    }
    default:
      throw new Error(`未知操作：${String(action)}，可用操作：${ACTIONS.join('、')}`)
  }
}

/**
 * Build the raw tool definition (no `defineTool` dependency).
 *
 * @param {{controller: object, guidance: object}} dependencies - tool dependencies.
 * @returns {object} `ctx.tools.register` definition.
 */
export function createTool(dependencies) {
  const controller = dependencies.controller
  const guidance = dependencies.guidance ?? { register: () => false }
  return {
    name: TOOL_NAME,
    description: [
      '闲时任务队列：管理 DeepSeek 与 GLM 闲时（优惠价）时段自动执行的任务；任务在它自己的来源对话里执行，不新开会话。任务按创建时对话所用模型的高峰日历排队（DeepSeek：工作日 09:00–12:00、14:00–18:00 高峰；GLM：工作日 14:00–18:00 高峰，均为北京时间）。',
      '创建：用户在「闲时任务」面板点「新建闲时任务」后，在那个对话里写好任务描述并回车即可，宿主会自动拦截入队（不需要调用本工具）。',
      '当用户说「执行这个任务」时，用 run_current 执行本会话绑定的等待中任务；用户要列队列/取消/重试/立即执行/删除时用对应 action。',
      'add 只用于用户明确要求把当前对话里的某件事加入闲时队列且尚未入队的情况，需要完整 prompt；任务会按当前对话的模型排期。',
      '不要自行开始执行任务内容；run_current 只在用户明确要求执行时调用。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTIONS,
          description: '操作：add 加入队列 · list 查看队列 · update 修改等待中的任务 · cancel 取消 · retry 重试已结束任务 · run_now 立即执行指定任务 · run_current 立即执行本会话绑定的任务 · delete 删除任务',
        },
        id: {
          type: 'string',
          description: '任务 id（update/cancel/retry/run_now/delete 必填，可由 list 获得；run_current 不需要）',
        },
        title: {
          type: 'string',
          description: '简短任务标题（可选，默认取 prompt 第一行）',
        },
        prompt: {
          type: 'string',
          description: '完整任务指令（add 必填）；作为任务内容，执行时模型会在来源对话里看到它',
        },
        cwd: {
          type: 'string',
          description: '任务的工作目录（可选，默认来源对话的工作目录）',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'markdown 结果说明' } },
        required: ['text'],
        additionalProperties: false,
      },
      /**
       * Render the markdown result as one text content block.
       *
       * @param {object} _args - tool arguments.
       * @param {{text: string}} value - tool output value.
       * @returns {Array<{type: 'text', text: string}>} content blocks.
       */
      render(_args, value) {
        return [{ type: 'text', text: value.text }]
      },
    },
    /**
     * Execute one offpeak_queue call.
     *
     * @param {object} args - model-supplied arguments.
     * @param {object} exec - tool execution context (agent scope).
     * @returns {Promise<{text: string}>} tool output value.
     */
    async execute(args, exec) {
      try {
        const agent = exec?.agent
        return { text: await runAction(args ?? {}, controller, agent, guidance) }
      } catch (error) {
        // Throwing becomes a normal isError tool result with the message.
        throw new Error(error instanceof Error ? error.message : String(error))
      }
    },
  }
}

/**
 * Register the tool on a Host context.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {object} controller - queue controller.
 * @param {object} guidance - session guidance registry.
 * @returns {() => void} exact disposer.
 */
export function registerTool(ctx, controller, guidance) {
  return ctx.tools.register(createTool({ controller, guidance }))
}
