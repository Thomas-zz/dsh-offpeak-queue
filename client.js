/**
 * Client half of dsh-offpeak-queue.
 *
 * Conversation-first off-peak tasks, entered from the composer:
 * - `/闲时任务` in the composer arms the current conversation for zero-call
 *   task creation; the next submitted message becomes the task and nothing
 *   calls a model at creation time.
 * - While armed, a compact chip in the composer toolbar shows the state and
 *   cancels it. There is no card above the composer, and no creation wizard.
 * - The panel (`main` key `offpeak`) lists the queue, savings statistics and
 *   settings. Queue rows stay minimal; details live in the source conversation.
 * - The sidebar panellist entry carries a small green dot while a finished
 *   task has not been seen in the panel.
 *
 * The page talks to the Host prefix route `/dsh-offpeak` with same-origin fetch.
 * Only `react` is imported; the module owns its locale namespace, stores and CSS.
 */
window.__ModuleLoader__.load({
  id: 'dsh-offpeak-queue',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'offpeakQueue'

    /** Page id: the `main` key and the sidebar panellist entry id. */
    const PANEL_ID = 'offpeak'

    /** Host HTTP route prefix. */
    const ROUTE = '/dsh-offpeak'

    /** Snapshot poll interval while any view is mounted. */
    const POLL_MS = 4000

    /** Faster snapshot poll while a creation is armed or a bound task runs. */
    const FAST_POLL_MS = 1000

    /** Statistics poll interval while the statistics section is mounted. */
    const STATS_POLL_MS = 8000

    /** How long a deletion confirmation stays armed. */
    const CONFIRM_MS = 5000

    /** How periodic countdown updates re-render (isolated component only). */
    const COUNTDOWN_MS = 1000

    /** Command name typed in the composer to arm off-peak creation. */
    const COMMAND_NAME = '闲时任务'

    /** localStorage key holding the newest finished-task time already seen. */
    const SEEN_STORAGE_KEY = 'dsh.offpeak.finishedSeenAt.v3'

    /** localStorage key remembering the workspace picked for a new task. */
    const WORKSPACE_STORAGE_KEY = 'dsh.offpeak.createWorkspace.v3'

    /** Default peak windows (DeepSeek rule), also used by “Restore defaults”. */
    const DEFAULT_PEAK_WINDOWS = [
      { weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
      { weekdays: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
    ]

    /** Default 2026 statutory holidays (weekdays only), used by “Restore defaults”. */
    const DEFAULT_HOLIDAYS = [
      '2026-01-01',
      '2026-01-02',
      '2026-02-16',
      '2026-02-17',
      '2026-02-18',
      '2026-02-19',
      '2026-02-20',
      '2026-02-23',
      '2026-04-06',
      '2026-05-01',
      '2026-05-04',
      '2026-05-05',
      '2026-06-19',
      '2026-09-25',
      '2026-10-01',
      '2026-10-02',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ]

    /** Built-in price table (CNY per million tokens, peak price), mirrored for the settings editor. */
    const DEFAULT_PRICES = {
      'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
      'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
      'deepseek-reasoner': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    }

    /** Settings defaults used when no snapshot has arrived yet and by “Restore defaults”. */
    const DEFAULT_SETTINGS = {
      autoRun: true,
      maxConcurrent: 3,
      taskTimeoutMinutes: 120,
      timeZone: 'Asia/Shanghai',
      peakWindows: DEFAULT_PEAK_WINDOWS,
      holidays: DEFAULT_HOLIDAYS,
      prices: DEFAULT_PRICES,
      familyEnabled: { deepseek: true, glm: true },
    }

    /** Built-in model families in display order (labels are brand names). */
    const FAMILY_ORDER = ['deepseek', 'glm']

    /**
     * Family label for one id, localized through the plugin namespace (labels
     * are brand names, so both dictionaries carry the same text).
     */
    function familyLabelOf(familyId, t) {
      const known = FAMILY_ORDER.includes(familyId) ? familyId : 'deepseek'
      return t(`family.${known}`)
    }

    /**
     * The family of one task with a DeepSeek fallback (older snapshots).
     *
     * @param {object} task - snapshot task.
     * @returns {string} family id.
     */
    function familyOfTask(task) {
      const value = pick(task, 'modelFamily')
      return FAMILY_ORDER.includes(value) ? value : 'deepseek'
    }

    /**
     * Enabled families with their billing period, in display order. Falls back
     * to the legacy single DeepSeek period while an older Host snapshot loads.
     *
     * @param {object} data - snapshot payload.
     * @param {Function} t - translate.
     * @returns {{id: string, label: string, period: object}[]} chips to render.
     */
    function billingChipsOf(data, t) {
      const periods = pick(data, 'periods')
      const chips = []
      for (const family of listOf(pick(data, 'families'))) {
        if (pick(family, 'enabled') === false) continue
        const id = typeof pick(family, 'id') === 'string' ? family.id : ''
        if (!FAMILY_ORDER.includes(id)) continue
        let period = periods && typeof periods === 'object' ? pick(periods, id) : null
        if ((!period || typeof period !== 'object') && id === 'deepseek') period = pick(data, 'period')
        if (!period || typeof period !== 'object') continue
        chips.push({
          id,
          label: familyLabelOf(id, t),
          zone: id === 'glm' ? 'Asia/Shanghai' : settingsOf(data).timeZone,
          period,
        })
      }
      if (chips.length === 0) {
        const fallback = pick(data, 'period')
        if (fallback && typeof fallback === 'object') {
          chips.push({ id: 'deepseek', label: familyLabelOf('deepseek', t), zone: settingsOf(data).timeZone, period: fallback })
        }
      }
      return chips
    }

    /** Task statuses grouped as finished in the UI. */
    const FINISHED_STATUSES = ['done', 'failed', 'cancelled']

    /** Task statuses that keep a session marked as active in the sidebar. */
    const ACTIVE_STATUSES = ['queued', 'running']

    /** Simplified Chinese dictionary (key-set source of truth). */
    const zh = {
      'panel': '闲时任务',
      'title': '闲时任务队列',

      'period.offpeak': '闲时 · 半价',
      'period.peak': '高峰 · 全价',
      'period.switchIn': '距切换 {time}',
      'period.offpeakUntil': '当前闲时时段至 {time}',
      'period.nextOffpeak': '下一个闲时时段：{time}',
      'period.weekendShort': '周末',
      'period.holidayShort': '节假日',
      'period.offpeakOpen': '当前处于闲时时段',
      'period.peakOpen': '高峰结束后进入闲时',
      'period.loading': '时段信息读取中',

      'family.deepseek': 'DeepSeek',
      'family.glm': 'GLM',

      'load.loading': '正在读取队列…',
      'load.errorTitle': '无法读取队列',
      'load.errorRetry': '重试',
      'load.stale': '连接 Host 暂时中断，显示的是上次读取的数据：{message}',

      'action.settings': '设置',
      'action.settingsClose': '关闭设置',
      'action.refresh': '刷新',

      'stats.all': '全部',
      'stats.queued': '等待',
      'stats.running': '执行中',
      'stats.done': '已完成',
      'stats.failed': '失败',
      'stats.cancelled': '已取消',

      'tabs.aria': '闲时任务视图',
      'tabs.queue': '任务队列',
      'tabs.stats': '统计',
      'tabs.statusAria': '任务状态',
      'list.empty': '这里还没有任务',

      'command.label': '闲时任务',
      'command.description': '回车开启，再写下任务回车入队',

      'chip.armed': '闲时任务',
      'chip.updating': '修改任务',
      'chip.cancel': '闲时任务已开启，点击取消',
      'chip.cancelUpdate': '修改任务中，回车保存，点击取消',
      'chip.cancelling': '取消中…',

      'toast.armed': '已开启闲时任务 · 写下任务后回车入队',
      'toast.disarmed': '已取消闲时任务',
      'toast.queued': '已加入闲时队列 · 预计 {time} 执行',
      'toast.queuedNow': '已加入闲时队列 · 即将开始执行',
      'toast.queuedNoTime': '已加入闲时队列',
      'toast.failed': '闲时任务操作失败：{message}',
      'toast.noWorkspace': '无法确定当前对话所属的工作区',
      'toast.editing': '任务内容已放入输入框，修改后回车保存',
      'toast.imagesKept': '已把 {n} 张图片放回输入框',
      'toast.updated': '任务已更新',

      'create.workspace': '工作区',
      'create.search': '搜索工作区…',
      'create.noMatch': '没有匹配的工作区',
      'create.noWorkspaceOption': '暂无工作区',
      'create.noWorkspace': '请先选择一个工作区',
      'create.submit': '新建闲时任务',
      'create.starting': '正在打开对话…',
      'create.unavailable': '工作区服务不可用，无法新建对话',
      'create.failed': '无法新建对话：{message}',

      'taskBar.created': '闲时任务已排队',
      'taskBar.running': '闲时任务执行中',
      'taskBar.cancelled': '闲时任务已取消',
      'taskBar.failed': '闲时任务执行失败',
      'taskBar.edit': '修改',
      'taskBar.cancel': '取消任务',
      'taskBar.retry': '重新入队',
      'taskBar.delete': '删除',
      'taskBar.confirmDelete': '确认删除',
      'taskBar.dismiss': '关闭提示',
      'taskBar.more': '+{n}',
      'taskBar.pending': '处理中…',
      'taskBar.aria': '闲时任务状态',
      'taskBar.expand': '展开任务详情',
      'taskBar.collapse': '收起任务详情',
      'taskBar.draftConflict': '输入框已有内容，请先清空再修改任务',

      'armed.title': '待创建对话',
      'armed.open': '打开对话',
      'armed.cancel': '取消',
      'armed.error': '上次提交未成功：{message}',
      'armed.aria': '待创建对话',
      'armed.updateMode': '修改任务中',

      'row.status.queued': '等待中',
      'row.status.running': '执行中',
      'row.status.done': '已完成',
      'row.status.failed': '失败',
      'row.status.cancelled': '已取消',
      'row.start': '立即执行',
      'row.starting': '启动中…',
      'row.cancel': '取消',
      'row.retry': '重试',
      'row.delete': '删除',
      'row.confirmDelete': '确认删除',
      'row.confirmHint': '再次点击确认',
      'row.openSource': '打开来源对话',
      'row.nextRun': '预计 {time} 执行',
      'row.soon': '即将开始执行',
      'row.forceQueued': '等待手动启动',
      'row.waiting': '等待闲时时段',
      'row.waitingManual': '等待手动执行',
      'row.runningFor': '已运行 {duration}',
      'row.finishedAt': '完成于 {time}',
      'row.cancelledAt': '取消于 {time}',
      'row.saved': '约省 {amount}',
      'row.pointsSaved': '闲时省 {points} 积分',
      'row.unpriced': '未计价',
      'row.peakNoSave': '峰时执行 · 未节省',
      'row.errorLabel': '错误',
      'row.pending': '处理中…',

      'statistics.title': '统计',
      'statistics.subtitle': '近 14 天 · 按实测 token 与各模型官方口径估算',
      'statistics.refresh': '刷新统计',
      'statistics.loading': '正在读取统计…',
      'statistics.error': '统计读取失败',
      'statistics.retry': '重试',
      'statistics.lifetimeSaved': '累计节省',
      'statistics.monthSaved': '本月节省',
      'statistics.runs': '累计运行',
      'statistics.familyRuns': '{family} 运行',
      'statistics.glmPoints': 'GLM 估算积分',
      'statistics.glmPointsSaved': 'GLM 闲时省积分',
      'statistics.pointsUnit': '积分',
      'statistics.chartTitle': '近 14 天',
      'statistics.legendSaved': '节省',
      'statistics.legendRuns': '运行次数',
      'statistics.chartEmpty': '近 14 天还没有执行记录',
      'statistics.byModel': '按模型',
      'statistics.tableModel': '模型',
      'statistics.tableRuns': '运行',
      'statistics.tableSaved': '节省',
      'statistics.tablePoints': '积分（估）',
      'statistics.tableTokens': 'Token',
      'statistics.tablePriced': '计价',
      'statistics.unpricedTag': '未计价',
      'statistics.pointsTag': '积分估算',
      'statistics.recent': '最近执行',
      'statistics.colTask': '任务',
      'statistics.colStatus': '状态',
      'statistics.colTrigger': '方式',
      'statistics.colTime': '时间',
      'statistics.colSaved': '节省',
      'statistics.recentEmpty': '还没有执行记录',
      'statistics.trigger.offpeak': '自动',
      'statistics.trigger.manual': '手动',
      'statistics.disclaimer': 'DeepSeek 按官方价目表、GLM 按官方积分系数与实测 token 估算，均非账单金额。',
      'statistics.pricesVerified': '价格核对于 {date}',
      'statistics.unknownModel': '未知模型',

      'settings.title': '设置',
      'settings.subtitle': '修改后点击保存，约 15 秒内生效。',
      'settings.maxConcurrent': '最大并发',
      'settings.maxConcurrentHint': '同时执行的任务数，1–5。',
      'settings.models': '模型闲时任务',
      'settings.modelsHint': '高峰时段按各模型官方规则自动配置；关闭后不再拦截该模型的入队消息，也不展示其高峰状态。',
      'settings.family.deepseek': 'DeepSeek 闲时任务',
      'settings.family.deepseekHint': '高峰：工作日 09:00–12:00、14:00–18:00（法定节假日除外）· 自动配置',
      'settings.family.glm': 'GLM 闲时任务',
      'settings.family.glmHint': '高峰：工作日 14:00–18:00（GLM Coding Plan 官方规则）· 自动配置',
      'settings.save': '保存',
      'settings.saving': '保存中…',
      'settings.reset': '恢复默认',
      'settings.resetHint': '已填入默认值，点击「保存」后生效。',
      'settings.saved': '设置已保存',
      'settings.numberInvalid': '请输入 {min}–{max} 的整数',
      'settings.decrease': '减少',
      'settings.increase': '增加',

      'mark.active': '有 {n} 个闲时任务',
      'mark.unseen': '有闲时任务已完成',

      'time.today': '今天',
      'time.tomorrow': '明天',
      'time.yesterday': '昨天',
      'time.locale': 'zh-CN',

      'duration.lessThanMinute': '不足 1 分钟',
      'duration.minutes': '{n} 分钟',
      'duration.hours': '{n} 小时',
      'duration.hoursMinutes': '{h} 小时 {m} 分钟',

      'footer.dataFile': '数据文件：',
      'footer.rule': '高峰时段外自动执行；DSH 需保持运行。',
    }

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      'panel': 'Off-peak',
      'title': 'Off-peak task queue',

      'period.offpeak': 'Off-peak · 50%',
      'period.peak': 'Peak · full price',
      'period.switchIn': '{time} to switch',
      'period.offpeakUntil': 'Off-peak until {time}',
      'period.nextOffpeak': 'Next off-peak: {time}',
      'period.weekendShort': 'weekend',
      'period.holidayShort': 'holiday',
      'period.offpeakOpen': 'Off-peak right now',
      'period.peakOpen': 'Off-peak begins after the peak window',
      'period.loading': 'Reading billing period',

      'family.deepseek': 'DeepSeek',
      'family.glm': 'GLM',

      'load.loading': 'Loading the queue…',
      'load.errorTitle': 'Could not load the queue',
      'load.errorRetry': 'Retry',
      'load.stale': 'Lost contact with the Host — showing the last snapshot: {message}',

      'action.settings': 'Settings',
      'action.settingsClose': 'Close settings',
      'action.refresh': 'Refresh',

      'stats.all': 'All',
      'stats.queued': 'Waiting',
      'stats.running': 'Running',
      'stats.done': 'Done',
      'stats.failed': 'Failed',
      'stats.cancelled': 'Cancelled',

      'tabs.aria': 'Off-peak views',
      'tabs.queue': 'Task queue',
      'tabs.stats': 'Statistics',
      'tabs.statusAria': 'Task status',
      'list.empty': 'No tasks in this view',

      'command.label': 'Off-peak task',
      'command.description': 'Press Enter to arm, then type the task and press Enter',

      'chip.armed': 'Off-peak',
      'chip.updating': 'Edit task',
      'chip.cancel': 'Off-peak task is on — click to cancel',
      'chip.cancelUpdate': 'Editing the task — press Enter to save, click to cancel',
      'chip.cancelling': 'Cancelling…',

      'toast.armed': 'Off-peak task on · type the task and press Enter to queue it',
      'toast.disarmed': 'Off-peak task cancelled',
      'toast.queued': 'Queued off-peak · runs {time}',
      'toast.queuedNow': 'Queued off-peak · starting shortly',
      'toast.queuedNoTime': 'Queued off-peak',
      'toast.failed': 'Off-peak action failed: {message}',
      'toast.noWorkspace': 'Could not resolve the workspace of this conversation',
      'toast.editing': 'Task text loaded into the composer — edit it and press Enter to save',
      'toast.imagesKept': '{n} image(s) put back into the composer',
      'toast.updated': 'Task updated',

      'create.workspace': 'Workspace',
      'create.search': 'Search workspaces…',
      'create.noMatch': 'No matching workspace',
      'create.noWorkspaceOption': 'No workspace yet',
      'create.noWorkspace': 'Pick a workspace first',
      'create.submit': 'New off-peak task',
      'create.starting': 'Opening the conversation…',
      'create.unavailable': 'The workspace service is unavailable; cannot open a conversation',
      'create.failed': 'Could not open the conversation: {message}',

      'taskBar.created': 'Off-peak task queued',
      'taskBar.running': 'Off-peak task is running',
      'taskBar.cancelled': 'Off-peak task cancelled',
      'taskBar.failed': 'Off-peak task failed',
      'taskBar.edit': 'Edit',
      'taskBar.cancel': 'Cancel task',
      'taskBar.retry': 'Queue again',
      'taskBar.delete': 'Delete',
      'taskBar.confirmDelete': 'Confirm delete',
      'taskBar.dismiss': 'Dismiss',
      'taskBar.more': '+{n} more tasks',
      'taskBar.pending': 'Working…',
      'taskBar.aria': 'Off-peak task status',
      'taskBar.expand': 'Show task details',
      'taskBar.collapse': 'Hide task details',
      'taskBar.draftConflict': 'The composer already has a draft; clear it before editing the task',

      'armed.title': 'Conversations awaiting a task',
      'armed.open': 'Open conversation',
      'armed.cancel': 'Cancel',
      'armed.error': 'Last submission failed: {message}',
      'armed.aria': 'Conversations awaiting a task',
      'armed.updateMode': 'Editing a task',

      'row.status.queued': 'Waiting',
      'row.status.running': 'Running',
      'row.status.done': 'Done',
      'row.status.failed': 'Failed',
      'row.status.cancelled': 'Cancelled',
      'row.start': 'Run now',
      'row.starting': 'Starting…',
      'row.cancel': 'Cancel',
      'row.retry': 'Retry',
      'row.delete': 'Delete',
      'row.confirmDelete': 'Confirm delete',
      'row.confirmHint': 'Click again to confirm',
      'row.openSource': 'Open the source conversation',
      'row.nextRun': 'Runs {time}',
      'row.soon': 'Starting shortly',
      'row.forceQueued': 'Waiting for a manual start',
      'row.waiting': 'Waiting for off-peak',
      'row.waitingManual': 'Waiting to run manually',
      'row.runningFor': 'Running for {duration}',
      'row.finishedAt': 'Finished {time}',
      'row.cancelledAt': 'Cancelled {time}',
      'row.saved': 'Saved ~{amount}',
      'row.pointsSaved': '{points} credits saved off-peak',
      'row.unpriced': 'Not priced',
      'row.peakNoSave': 'Ran at peak · no savings',
      'row.errorLabel': 'Error',
      'row.pending': 'Working…',

      'statistics.title': 'Statistics',
      'statistics.subtitle': 'Last 14 days · estimated from measured tokens and official price/credit rules',
      'statistics.refresh': 'Refresh statistics',
      'statistics.loading': 'Loading statistics…',
      'statistics.error': 'Could not load the statistics',
      'statistics.retry': 'Retry',
      'statistics.lifetimeSaved': 'Total saved',
      'statistics.monthSaved': 'Saved this month',
      'statistics.runs': 'Total runs',
      'statistics.familyRuns': '{family} runs',
      'statistics.glmPoints': 'GLM credits (est.)',
      'statistics.glmPointsSaved': 'GLM credits saved',
      'statistics.pointsUnit': 'credits',
      'statistics.chartTitle': 'Last 14 days',
      'statistics.legendSaved': 'Saved',
      'statistics.legendRuns': 'Runs',
      'statistics.chartEmpty': 'No runs in the last 14 days',
      'statistics.byModel': 'By model',
      'statistics.tableModel': 'Model',
      'statistics.tableRuns': 'Runs',
      'statistics.tableSaved': 'Saved',
      'statistics.tablePoints': 'Credits (est.)',
      'statistics.tableTokens': 'Tokens',
      'statistics.tablePriced': 'Priced',
      'statistics.unpricedTag': 'Not priced',
      'statistics.pointsTag': 'credits est.',
      'statistics.recent': 'Recent runs',
      'statistics.colTask': 'Task',
      'statistics.colStatus': 'Status',
      'statistics.colTrigger': 'Trigger',
      'statistics.colTime': 'Time',
      'statistics.colSaved': 'Saved',
      'statistics.recentEmpty': 'No runs yet',
      'statistics.trigger.offpeak': 'Auto',
      'statistics.trigger.manual': 'Manual',
      'statistics.disclaimer': 'DeepSeek from the official price list, GLM from official credit coefficients × measured tokens; estimates, not bills.',
      'statistics.pricesVerified': 'Prices verified {date}',
      'statistics.unknownModel': 'Unknown model',

      'settings.title': 'Settings',
      'settings.subtitle': 'Changes take effect within ~15 s of saving.',
      'settings.maxConcurrent': 'Max concurrency',
      'settings.maxConcurrentHint': 'Tasks running at once, 1–5.',
      'settings.models': 'Model off-peak tasks',
      'settings.modelsHint': 'Peak windows follow each model’s official rule automatically; a disabled model is never intercepted and shows no status chip.',
      'settings.family.deepseek': 'DeepSeek off-peak tasks',
      'settings.family.deepseekHint': 'Peak: weekdays 09:00–12:00 & 14:00–18:00 (excl. public holidays) · automatic',
      'settings.family.glm': 'GLM off-peak tasks',
      'settings.family.glmHint': 'Peak: weekdays 14:00–18:00 (GLM Coding Plan rule) · automatic',
      'settings.save': 'Save',
      'settings.saving': 'Saving…',
      'settings.reset': 'Restore defaults',
      'settings.resetHint': 'Defaults filled in — press Save to apply.',
      'settings.saved': 'Settings saved',
      'settings.numberInvalid': 'Enter an integer from {min} to {max}',
      'settings.decrease': 'Decrease',
      'settings.increase': 'Increase',

      'mark.active': '{n} off-peak tasks',
      'mark.unseen': 'A finished off-peak task is ready',

      'time.today': 'Today',
      'time.tomorrow': 'Tomorrow',
      'time.yesterday': 'Yesterday',
      'time.locale': 'en-US',

      'duration.lessThanMinute': 'under a minute',
      'duration.minutes': '{n} min',
      'duration.hours': '{n} h',
      'duration.hoursMinutes': '{h} h {m} min',

      'footer.dataFile': 'Data file: ',
      'footer.rule': 'Runs outside peak windows; DSH must stay running.',
    }


    // ────────────────────────────────────────────────────────────────────────
    // Small helpers
    // ────────────────────────────────────────────────────────────────────────

    /** Left-pad a number to two digits. */
    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /** Coerce into an array without trusting the payload. */
    function listOf(value) {
      return Array.isArray(value) ? value : []
    }

    /** Read a nested property without throwing on a null chain. */
    function pick(object, key) {
      return object && typeof object === 'object' ? object[key] : undefined
    }

    /** Human-readable message for an unknown thrown value. */
    function messageOf(error) {
      if (error instanceof Error && error.message) return error.message
      const text = String(error === undefined || error === null ? '' : error)
      return text || 'unknown error'
    }

    /** Prefer a finite number, else a fallback. */
    function numberOr(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback
    }

    /** `1:23:45` style countdown, `mm:ss` under one hour. */
    function formatCountdown(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '0:00'
      const total = Math.ceil(ms / 1000)
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      return hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${minutes}:${pad2(seconds)}`
    }

    /** Elapsed time as a coarse, localized duration. */
    function formatDuration(ms, t) {
      if (!Number.isFinite(ms) || ms < 60000) return t('duration.lessThanMinute')
      const minutes = Math.floor(ms / 60000)
      if (minutes < 60) return t('duration.minutes', { n: minutes })
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      return rest === 0 ? t('duration.hours', { n: hours }) : t('duration.hoursMinutes', { h: hours, m: rest })
    }

    /**
     * Elapsed time for the compact task pill: a fixed-width clock so the pill
     * never reflows while it runs (`0:42`, `12:07`, `1:04:09`).
     *
     * @param {number} ms - elapsed milliseconds.
     * @returns {string} clock text, empty when the value is unusable.
     */
    function formatClock(ms) {
      if (!Number.isFinite(ms) || ms < 0) return ''
      const total = Math.floor(ms / 1000)
      const seconds = total % 60
      const minutes = Math.floor(total / 60) % 60
      const hours = Math.floor(total / 3600)
      const pad = (value) => String(value).padStart(2, '0')
      if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`
      return `${minutes}:${pad(seconds)}`
    }

    /** Last path segment, for compact workspace labels. */
    function baseName(path) {
      const parts = String(path || '')
        .split(/[\\/]+/)
        .filter(Boolean)
      return parts.length > 0 ? parts[parts.length - 1] : String(path || '')
    }

    /**
     * Build an Intl formatter with the host time zone, falling back to the
     * system zone when the payload carries an unusable zone.
     *
     * @param {string} zone - IANA zone from settings.
     * @param {string} locale - ICU locale from the dictionary.
     * @param {Intl.DateTimeFormatOptions} options - formatter options.
     * @returns {Intl.DateTimeFormat} formatter.
     */
    function zoneFormatter(zone, locale, options) {
      try {
        return new Intl.DateTimeFormat(locale, { ...options, timeZone: zone })
      } catch {
        try {
          return new Intl.DateTimeFormat(locale, options)
        } catch {
          return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
        }
      }
    }

    /** Calendar date in the host zone as `YYYY-MM-DD`. */
    function zoneDateKey(ms, zone) {
      try {
        return zoneFormatter(zone, 'en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms)
      } catch {
        return ''
      }
    }

    /** Whole-day difference between two `YYYY-MM-DD` keys (to - from). */
    function dateKeyDiff(to, from) {
      const parse = (key) => {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''))
        return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN
      }
      const left = parse(to)
      const right = parse(from)
      if (!Number.isFinite(left) || !Number.isFinite(right)) return NaN
      return Math.round((left - right) / 86400000)
    }

    /** `18:00` in the host zone. */
    function formatClock(ms, t, zone) {
      try {
        return zoneFormatter(zone, t('time.locale'), { hour: '2-digit', minute: '2-digit', hour12: false }).format(ms)
      } catch {
        const date = new Date(ms)
        return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
      }
    }

    /** Localized short date (`11月5日` / `Nov 5`), with the year when it differs. */
    function formatShortDate(ms, t, zone, includeYear) {
      try {
        const options = includeYear
          ? { year: 'numeric', month: 'short', day: 'numeric' }
          : { month: 'short', day: 'numeric' }
        return zoneFormatter(zone, t('time.locale'), options).format(ms)
      } catch {
        const date = new Date(ms)
        return `${date.getMonth() + 1}/${date.getDate()}`
      }
    }

    /**
     * Relative timestamp: `今天 18:00`, `明天 09:00`, `11月5日 18:00`.
     *
     * @param {number} ms - instant to describe.
     * @param {Function} t - translate.
     * @param {string} zone - host IANA zone.
     * @param {number} nowMs - reference instant.
     * @returns {string} human timestamp.
     */
    function formatWhen(ms, t, zone, nowMs) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
      const clock = formatClock(ms, t, zone)
      const diff = dateKeyDiff(zoneDateKey(ms, zone), zoneDateKey(nowMs, zone))
      if (diff === 0) return `${t('time.today')} ${clock}`
      if (diff === 1) return `${t('time.tomorrow')} ${clock}`
      if (diff === -1) return `${t('time.yesterday')} ${clock}`
      const thisYear = String(zoneDateKey(nowMs, zone)).slice(0, 4)
      const otherYear = String(zoneDateKey(ms, zone)).slice(0, 4)
      return `${formatShortDate(ms, t, zone, thisYear !== otherYear)} ${clock}`
    }

    // ────────────────────────────────────────────────────────────────────────
    // Task, cost and calendar display helpers
    // ────────────────────────────────────────────────────────────────────────

    /** Format a CNY amount with enough precision for tiny token costs. */
    function formatCny(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value === 0) return '¥0'
      const abs = Math.abs(value)
      const digits = abs >= 1 ? 2 : abs >= 0.1 ? 3 : abs >= 0.01 ? 4 : 5
      return `¥${value.toFixed(digits)}`
    }

    /** Format an estimated GLM credit amount with sensible precision. */
    function formatPoints(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (value === 0) return '0'
      const abs = Math.abs(value)
      if (abs >= 10000) return `${Math.round(value / 100) / 10}w`
      if (abs >= 100) return String(Math.round(value))
      if (abs >= 10) return String(Math.round(value * 10) / 10)
      return String(Math.round(value * 100) / 100)
    }

    /** Compact localized token count, e.g. 1.2万 / 12K. */
    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—'
      try {
        return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
      } catch {
        return String(Math.round(value))
      }
    }

    /** Read a numeric member that may arrive as a plain number or inside a cost object. */
    function costNumber(value, keys) {
      if (typeof value === 'number' && Number.isFinite(value)) return value
      if (!value || typeof value !== 'object') return undefined
      for (const key of keys) {
        const inner = value[key]
        if (typeof inner === 'number' && Number.isFinite(inner)) return inner
      }
      return undefined
    }

    /** Actual cost recorded on a task, when known. */
    function costOfTask(task) {
      return costNumber(pick(task, 'cost'), ['actual', 'cost', 'actualCost'])
    }

    /** Saved amount recorded on a task, when known. */
    function savedOfTask(task) {
      return costNumber(pick(task, 'saved'), ['saved', 'actual'])
    }

    /** Whether a finished task ran with unpriced tokens (no price table entry). */
    function taskUnpriced(task) {
      if (pick(task, 'unpriced') === true) return true
      const status = typeof pick(task, 'status') === 'string' ? task.status : ''
      if (!FINISHED_STATUSES.includes(status)) return false
      if (costOfTask(task) !== undefined) return false
      const usage = pick(task, 'usage')
      const steps = listOf(pick(task, 'steps'))
      return !!(usage && typeof usage === 'object') || steps.length > 0
    }

    /** Localized status label for a task status. */
    function statusLabel(t, status) {
      const known = ['queued', 'running', 'done', 'failed', 'cancelled'].includes(status) ? status : 'queued'
      return t(`row.status.${known}`)
    }

    /** Newest finish time among the done/failed tasks visible in a snapshot. */
    function latestFinishedAt(data) {
      let latest = 0
      for (const task of listOf(pick(data, 'tasks'))) {
        const status = typeof pick(task, 'status') === 'string' ? task.status : ''
        if (status !== 'done' && status !== 'failed') continue
        const finishedAt = pick(task, 'finishedAt')
        if (typeof finishedAt === 'number' && Number.isFinite(finishedAt) && finishedAt > latest) latest = finishedAt
      }
      return latest
    }

    /** Whether a finished task is newer than the last panel visit. */
    function hasUnseenFinished(data, seenAt) {
      const latest = latestFinishedAt(data)
      return latest > 0 && latest > seenAt
    }

    /** Host route for arming one conversation for zero-call task creation. */
    function armPath(sessionId) {
      return `/sessions/${encodeURIComponent(sessionId)}/arm`
    }

    /** Host route for disarming one conversation. */
    function disarmPath(sessionId) {
      return `/sessions/${encodeURIComponent(sessionId)}/disarm`
    }

    /** Host route for one task action. */
    function taskPath(task, action) {
      return `/tasks/${encodeURIComponent(String(pick(task, 'id')))}/${action}`
    }

    /**
     * Whether a task is an active (queued/running) task bound to a session.
     *
     * @param {object} task - snapshot task.
     * @returns {boolean} active flag.
     */
    function isActiveTask(task) {
      return ACTIVE_STATUSES.includes(typeof pick(task, 'status') === 'string' ? task.status : '')
    }

    /**
     * Timing phrase for one task: expected start, running duration, or finish time.
     *
     * @param {object} task - snapshot task.
     * @param {object} data - snapshot payload.
     * @param {Function} t - translate.
     * @param {number} now - Host clock estimate.
     * @returns {{ text: string, strong: boolean }} timing phrase.
     */
    function timingOfTask(task, data, t, now) {
      const settings = settingsOf(data)
      const zone = settings.timeZone
      const status = typeof pick(task, 'status') === 'string' ? task.status : 'queued'
      if (status === 'queued') {
        if (pick(task, 'forceRun') === true) return { text: t('row.forceQueued'), strong: true }
        if (settings.autoRun === false) return { text: t('row.waitingManual'), strong: true }
        const nextRunAt = pick(task, 'nextRunAt')
        if (typeof nextRunAt === 'number' && Number.isFinite(nextRunAt)) {
          if (nextRunAt - now <= 5000) return { text: t('row.soon'), strong: true }
          return { text: t('row.nextRun', { time: formatWhen(nextRunAt, t, zone, now) }), strong: true }
        }
        return { text: t('row.waiting'), strong: false }
      }
      if (status === 'running') {
        const startedAt = pick(task, 'startedAt')
        if (typeof startedAt === 'number' && Number.isFinite(startedAt)) {
          return { text: t('row.runningFor', { duration: formatDuration(now - startedAt, t) }), strong: true }
        }
        return { text: t('row.soon'), strong: false }
      }
      const finishedAt = pick(task, 'finishedAt')
      if (typeof finishedAt === 'number' && Number.isFinite(finishedAt)) {
        const time = formatWhen(finishedAt, t, zone, now)
        return {
          text: status === 'cancelled' ? t('row.cancelledAt', { time }) : t('row.finishedAt', { time }),
          strong: true,
        }
      }
      return { text: '', strong: false }
    }

    /** Savings phrase for a finished task, or null when the task is not priced yet. */
    function savingsOfTask(task, t) {
      if (familyOfTask(task) === 'glm') {
        // GLM runs carry estimated Coding-Plan credits instead of CNY.
        const pointsSaved = costNumber(pick(task, 'pointsSaved'), ['pointsSaved'])
        const points = costNumber(pick(task, 'points'), ['points'])
        if (typeof pointsSaved === 'number' && pointsSaved > 0) {
          return { text: t('row.pointsSaved', { points: formatPoints(pointsSaved) }), kind: 'saved' }
        }
        if (typeof points === 'number' && points > 0) return { text: t('row.peakNoSave'), kind: 'cost' }
        if (typeof points !== 'number') return { text: t('row.unpriced'), kind: 'unpriced' }
        return null
      }
      if (taskUnpriced(task)) return { text: t('row.unpriced'), kind: 'unpriced' }
      const saved = savedOfTask(task)
      if (typeof saved === 'number' && saved > 0) {
        return { text: t('row.saved', { amount: formatCny(saved) }), kind: 'saved' }
      }
      const cost = costOfTask(task)
      if (typeof cost === 'number' && cost > 0) return { text: t('row.peakNoSave'), kind: 'cost' }
      return null
    }

    /** Build the last-`days` day series for the statistics chart from `byDay`. */
    function buildDaySeries(byDay, days, now, zone) {
      const index = new Map()
      for (const entry of listOf(byDay)) {
        const date = typeof pick(entry, 'date') === 'string' ? entry.date : ''
        if (date) index.set(date, entry)
      }
      const series = []
      for (let offset = days - 1; offset >= 0; offset -= 1) {
        const stamp = now - offset * 86400000
        const date = zoneDateKey(stamp, zone)
        const entry = index.get(date)
        series.push({
          date,
          runs: numberOr(pick(entry, 'runs'), 0),
          cost: numberOr(pick(entry, 'cost'), 0),
          saved: numberOr(pick(entry, 'saved'), 0),
        })
      }
      return series
    }

    /** Maximum numeric value across the provided fields of a day series. */
    function seriesMax(series) {
      let max = 0
      for (const day of series) {
        max = Math.max(max, day.cost, day.saved)
      }
      return max
    }


    // ────────────────────────────────────────────────────────────────────────
    // Transport
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Same-origin JSON request against the Host route.
     *
     * @param {string} path - path under the route prefix.
     * @param {RequestInit} [init] - fetch options.
     * @returns {Promise<any>} decoded payload.
     */
    async function apiRequest(path, init) {
      const response = await fetch(`${ROUTE}${path}`, {
        ...init,
        headers: {
          accept: 'application/json',
          ...(init && init.headers),
        },
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (!response.ok || !payload || payload.ok === false) {
        throw new Error((payload && payload.ok === false && payload.error) || `HTTP ${response.status}`)
      }
      return payload
    }

    /** POST a JSON body and return the decoded payload. */
    function postJson(path, body) {
      return apiRequest(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body),
      })
    }

    // ────────────────────────────────────────────────────────────────────────
    // Shared stores (snapshot, seen state, statistics, toasts)
    // ────────────────────────────────────────────────────────────────────────

    /**
     * One module-level snapshot store: every mounted view (panel, composer chip,
     * sidebar marks, toast watcher) shares the same snapshot and the same poll.
     * Polling runs only while someone listens; callers that need live run
     * feedback retain a fast (1 s) interval for as long as they need it.
     *
     * @returns {object} store with subscribe/getSnapshot/refresh/mutate/post/retainFast/dispose.
     */
    function createSnapshotStore() {
      let state = { phase: 'loading', data: undefined, error: undefined, receivedAt: 0, serverOffset: 0 }
      const listeners = new Set()
      let pollTimer = 0
      let inFlight
      let disposed = false
      let fastRefs = 0
      let interval = POLL_MS

      const publish = (next) => {
        state = next
        for (const listener of Array.from(listeners)) listener()
      }

      const fetchSnapshot = async () => {
        try {
          const payload = await apiRequest('/snapshot')
          if (disposed) return
          const receivedAt = Date.now()
          publish({
            phase: 'ready',
            data: payload,
            error: undefined,
            receivedAt,
            serverOffset: numberOr(payload.now, receivedAt) - receivedAt,
          })
        } catch (error) {
          if (disposed) return
          publish({ ...state, phase: state.data ? 'ready' : 'error', error: messageOf(error) })
        }
      }

      const refresh = () => {
        if (inFlight) return inFlight
        inFlight = fetchSnapshot().finally(() => {
          inFlight = undefined
        })
        return inFlight
      }

      const stopTimer = () => {
        if (pollTimer) clearInterval(pollTimer)
        pollTimer = 0
      }

      const startTimer = () => {
        stopTimer()
        pollTimer = setInterval(() => void refresh(), interval)
      }

      const subscribe = (listener) => {
        listeners.add(listener)
        if (listeners.size === 1) {
          void refresh()
          startTimer()
        }
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0) stopTimer()
        }
      }

      /**
       * Retain the fast (1 s) poll interval; releasing the last retention
       * returns to the shared 4 s cadence.
       *
       * @returns {Function} release callback (idempotent).
       */
      const retainFast = () => {
        fastRefs += 1
        if (interval !== FAST_POLL_MS) {
          interval = FAST_POLL_MS
          if (pollTimer) startTimer()
        }
        let released = false
        return () => {
          if (released) return
          released = true
          fastRefs = Math.max(0, fastRefs - 1)
          if (fastRefs === 0 && interval !== POLL_MS) {
            interval = POLL_MS
            if (pollTimer) startTimer()
          }
        }
      }

      /** POST one mutation, wait out a stale snapshot read, then refresh. */
      const mutate = async (path, body) => {
        const payload = await postJson(path, body)
        if (inFlight) {
          try {
            await inFlight
          } catch {
            /* a failed background read must not hide the mutation result */
          }
        }
        await refresh()
        return payload
      }

      const dispose = () => {
        disposed = true
        stopTimer()
        listeners.clear()
      }

      return { subscribe, getSnapshot: () => state, refresh, mutate, retainFast, dispose }
    }

    /** Host clock estimate for the latest snapshot. */
    function nowOf(snapshot) {
      if (!snapshot || !snapshot.receivedAt) return Date.now()
      return Date.now() + snapshot.serverOffset
    }

    /**
     * Newest finished-task time already seen in the panel, persisted locally.
     * The sidebar entry reads it to decide whether to show its green dot.
     *
     * @returns {object} store with subscribe/getSnapshot/mark/dispose.
     */
    function createSeenStore() {
      const read = () => {
        try {
          const value = Number(window.localStorage.getItem(SEEN_STORAGE_KEY))
          return Number.isFinite(value) ? value : 0
        } catch {
          return 0
        }
      }
      const write = (value) => {
        try {
          window.localStorage.setItem(SEEN_STORAGE_KEY, String(value))
        } catch {
          /* private mode or a full quota must not break the dot */
        }
      }
      let seenAt = read()
      if (seenAt <= 0) {
        // First load: treat the existing history as already seen.
        seenAt = Date.now()
        write(seenAt)
      }
      const listeners = new Set()
      const publish = () => {
        for (const listener of Array.from(listeners)) listener()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot: () => seenAt,
        mark(value) {
          const next = Number.isFinite(value) ? Math.max(seenAt, value) : seenAt
          if (next === seenAt) return
          seenAt = next
          write(seenAt)
          publish()
        },
        dispose() {
          listeners.clear()
        },
      }
    }

    /**
     * Statistics store: `/stats?days=14` is polled only while a statistics
     * section is mounted, plus an explicit refresh after relevant mutations.
     *
     * @returns {object} store with subscribe/getSnapshot/refresh/dispose.
     */
    function createStatsStore() {
      let state = { phase: 'loading', data: undefined, error: undefined }
      const listeners = new Set()
      let pollTimer = 0
      let inFlight
      let disposed = false

      const publish = (next) => {
        state = next
        for (const listener of Array.from(listeners)) listener()
      }

      const fetchStats = async () => {
        try {
          const payload = await apiRequest('/stats?days=14')
          if (disposed) return
          publish({ phase: 'ready', data: payload, error: undefined })
        } catch (error) {
          if (disposed) return
          publish({ ...state, phase: state.data ? 'ready' : 'error', error: messageOf(error) })
        }
      }

      const refresh = () => {
        if (inFlight) return inFlight
        inFlight = fetchStats().finally(() => {
          inFlight = undefined
        })
        return inFlight
      }

      const subscribe = (listener) => {
        listeners.add(listener)
        if (listeners.size === 1) {
          void refresh()
          pollTimer = setInterval(() => void refresh(), STATS_POLL_MS)
        }
        return () => {
          listeners.delete(listener)
          if (listeners.size === 0 && pollTimer) {
            clearInterval(pollTimer)
            pollTimer = 0
          }
        }
      }

      const dispose = () => {
        disposed = true
        if (pollTimer) clearInterval(pollTimer)
        pollTimer = 0
        listeners.clear()
      }

      return { subscribe, getSnapshot: () => state, refresh, dispose }
    }

    /**
     * Small app-level toast queue rendered by this plugin in `shell.overlay`
     * (the composer command has no notify surface of its own).
     *
     * @returns {object} store with subscribe/getSnapshot/push/dismiss/dispose.
     */
    function createToastStore() {
      let toasts = []
      let seq = 0
      const listeners = new Set()
      const timers = new Map()

      const publish = () => {
        for (const listener of Array.from(listeners)) listener()
      }

      const dismiss = (id) => {
        const timer = timers.get(id)
        if (timer) clearTimeout(timer)
        timers.delete(id)
        const next = toasts.filter((toast) => toast.id !== id)
        if (next.length === toasts.length) return
        toasts = next
        publish()
      }

      const push = (kind, text) => {
        seq += 1
        const toast = { id: seq, kind, text }
        toasts = [...toasts.slice(-2), toast]
        timers.set(toast.id, setTimeout(() => dismiss(toast.id), 4600))
        publish()
        return toast.id
      }

      const dispose = () => {
        for (const timer of timers.values()) clearTimeout(timer)
        timers.clear()
        toasts = []
        listeners.clear()
        publish()
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot: () => toasts,
        push,
        dismiss,
        dispose,
      }
    }

    /**
     * Minimal boolean store shared between React trees: the management page
     * toggles it, the shell-overlay settings modal reads it.
     *
     * @param {boolean} initial - initial flag value.
     * @returns {{subscribe: Function, getSnapshot: Function, set: Function, dispose: Function}} flag store.
     */
    function createFlagStore(initial) {
      let value = initial === true
      const listeners = new Set()
      const publish = () => {
        for (const listener of Array.from(listeners)) listener()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot: () => value,
        set(next) {
          const nextValue = next === true
          if (nextValue === value) return
          value = nextValue
          publish()
        },
        dispose() {
          listeners.clear()
          value = false
        },
      }
    }

    /** Read any of the module stores through React's external store hook. */
    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    /** Read the shared snapshot through the external store hook. */
    function useSnapshot(store) {
      return useStore(store)
    }


    // ────────────────────────────────────────────────────────────────────────
    // Settings helpers
    // ────────────────────────────────────────────────────────────────────────

    /** Deep price-table copy with only finite non-negative numbers; null when unusable. */
    function pricesOf(value) {
      if (!value || typeof value !== 'object') return null
      const prices = {}
      let count = 0
      for (const [model, entry] of Object.entries(value)) {
        if (!model || !entry || typeof entry !== 'object') continue
        const cacheHit = numberOr(entry.cacheHit, NaN)
        const cacheMiss = numberOr(entry.cacheMiss, NaN)
        const output = numberOr(entry.output, NaN)
        if (!Number.isFinite(cacheHit) || !Number.isFinite(cacheMiss) || !Number.isFinite(output)) continue
        prices[model] = { cacheHit, cacheMiss, output }
        count += 1
      }
      return count > 0 ? prices : null
    }

    /** Effective settings with defensive fallbacks. */
    function settingsOf(data) {
      const raw = pick(data, 'settings')
      if (!raw || typeof raw !== 'object') return DEFAULT_SETTINGS
      return {
        autoRun: raw.autoRun !== false,
        maxConcurrent: numberOr(raw.maxConcurrent, DEFAULT_SETTINGS.maxConcurrent),
        taskTimeoutMinutes: numberOr(raw.taskTimeoutMinutes, DEFAULT_SETTINGS.taskTimeoutMinutes),
        timeZone: typeof raw.timeZone === 'string' && raw.timeZone ? raw.timeZone : DEFAULT_SETTINGS.timeZone,
        peakWindows: listOf(raw.peakWindows).length > 0 ? raw.peakWindows : DEFAULT_SETTINGS.peakWindows,
        holidays: Array.isArray(raw.holidays) ? raw.holidays : DEFAULT_SETTINGS.holidays,
        holidayYears: listOf(raw.holidayYears).filter((year) => Number.isInteger(year)),
        prices: pricesOf(raw.prices) || DEFAULT_PRICES,
        pricesVerifiedAt: typeof raw.pricesVerifiedAt === 'string' ? raw.pricesVerifiedAt : '',
        familyEnabled: {
          deepseek: pick(raw.familyEnabled, 'deepseek') !== false,
          glm: pick(raw.familyEnabled, 'glm') !== false,
        },
      }
    }

    /** Initialize the editable settings form from persisted settings. */
    function settingsToForm(settings) {
      return {
        maxConcurrent: String(numberOr(settings.maxConcurrent, DEFAULT_SETTINGS.maxConcurrent)),
        familyEnabled: {
          deepseek: settings.familyEnabled?.deepseek !== false,
          glm: settings.familyEnabled?.glm !== false,
        },
      }
    }

    /**
     * Validate the settings form and produce the partial settings payload.
     *
     * @param {object} form - editable form state.
     * @param {Function} t - translate.
     * @returns {{ body?: object, errors: Record<string, string> }} validated payload or field errors.
     */
    function buildSettingsBody(form, t) {
      const errors = {}
      const maxConcurrent = Number(form.maxConcurrent)
      if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 5) {
        errors.maxConcurrent = t('settings.numberInvalid', { min: 1, max: 5 })
      }
      if (Object.keys(errors).length > 0) return { errors }
      return {
        errors,
        body: {
          maxConcurrent,
          familyEnabled: {
            deepseek: form.familyEnabled?.deepseek === true,
            glm: form.familyEnabled?.glm === true,
          },
        },
      }
    }

    // ────────────────────────────────────────────────────────────────────────
    // Page stylesheet
    // ────────────────────────────────────────────────────────────────────────

    const STYLES = `
      .dsh-oq-page{box-sizing:border-box;flex:1 1 auto;min-width:0;min-height:0;height:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}
      .dsh-oq-scroll{flex:1 1 auto;min-height:0;overflow:auto;scrollbar-gutter:stable}
      .dsh-oq-content{max-width:1000px;margin:0 auto;padding:calc(20px + var(--dsh-frame-top-clearance, 0px)) clamp(18px, 4vw, 40px) 44px}

      .dsh-oq-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 24px}
      .dsh-oq-headMain{flex:1 1 320px;min-width:0}
      .dsh-oq-h1{margin:0;font-size:20px;font-weight:500;line-height:28px;letter-spacing:.01em}
      .dsh-oq-headButtons{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px}

      .dsh-oq-statusStrip{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:8px;margin-top:14px}
      .dsh-oq-chip{min-width:0;max-width:100%;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:10px 14px 11px}
      .dsh-oq-chipMain{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap}
      .dsh-oq-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent)}
      .dsh-oq-dot--peak{background:var(--dsw-alias-state-warn-primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent)}
      .dsh-oq-dot--idle{background:var(--dsw-alias-state-idle-primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-idle-primary) 18%, transparent)}
      .dsh-oq-chipFamily{flex:none;font-size:13px;font-weight:600;letter-spacing:.01em}
      .dsh-oq-chipPeriod{display:inline-flex;align-items:center;flex:none;padding:1px 8px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:16px;white-space:nowrap}
      .dsh-oq-chipPeriod[data-tone="peak"]{background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);color:var(--dsw-alias-state-warn-primary)}
      .dsh-oq-chipPeriod[data-tone="offpeak"]{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 13%, transparent);color:var(--dsw-alias-state-success-primary)}
      .dsh-oq-chipCountdown{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400;font-variant-numeric:tabular-nums;white-space:nowrap}
      .dsh-oq-chipSub{margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
      .dsh-oq-familyTag{display:inline-flex;align-items:center;flex:none;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:16px;white-space:nowrap}


      .dsh-oq-notice{display:flex;align-items:flex-start;gap:8px;margin-top:14px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:9px 13px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;overflow-wrap:anywhere}
      .dsh-oq-noticeDot{flex:none;width:6px;height:6px;margin-top:7px;border-radius:50%;background:var(--dsw-alias-label-secondary)}
      .dsh-oq-notice[data-kind="success"] .dsh-oq-noticeDot{background:var(--dsw-alias-state-success-primary)}
      .dsh-oq-notice[data-kind="warn"] .dsh-oq-noticeDot{background:var(--dsw-alias-state-warn-primary)}
      .dsh-oq-notice[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}

      .dsh-oq-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;height:32px;padding:0 14px;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer;transition:background .12s ease, color .12s ease, border-color .12s ease, opacity .12s ease}
      .dsh-oq-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-oq-btn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
      .dsh-oq-btn:disabled{cursor:not-allowed;opacity:.45}
      .dsh-oq-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
      .dsh-oq-btn--primary{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
      .dsh-oq-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
      .dsh-oq-btn--outline{border-color:var(--dsw-alias-border-l2)}
      .dsh-oq-btn--outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-oq-btn--ghost{color:var(--dsw-alias-label-secondary)}
      .dsh-oq-btn--ghost:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-oq-btn--danger{color:var(--dsw-alias-state-error-primary)}
      .dsh-oq-btn--danger:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);color:var(--dsw-alias-state-error-primary)}
      .dsh-oq-btn--dangerArmed{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}
      .dsh-oq-btn--dangerArmed:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base);opacity:.92}
      .dsh-oq-btn--sm{height:27px;padding:0 9px;font-size:12px;line-height:18px;border-radius:7px}
      .dsh-oq-btn--icon{width:27px;padding:0}
      .dsh-oq-btn--link{height:26px;padding:0 8px;font-size:12px;color:var(--dsw-alias-state-business-primary)}
      .dsh-oq-btn--link:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent);color:var(--dsw-alias-state-business-primary)}

      .dsh-oq-card{margin-top:16px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
      .dsh-oq-field{display:flex;flex-direction:column;gap:5px;min-width:0}
      .dsh-oq-field--wide{grid-column:1 / -1}
      .dsh-oq-label{display:flex;align-items:baseline;gap:6px;font-size:13px;font-weight:500;line-height:20px}
      .dsh-oq-labelHint{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:400;line-height:18px;overflow-wrap:anywhere}
      .dsh-oq-input{box-sizing:border-box;width:100%;min-width:0;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:6px 10px;transition:border-color .12s ease, box-shadow .12s ease}
      .dsh-oq-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.7}
      .dsh-oq-input:hover{border-color:var(--dsw-alias-border-l2)}
      .dsh-oq-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent)}
      .dsh-oq-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}
      .dsh-oq-fieldError{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}

      .dsh-oq-rows{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
      .dsh-oq-row{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:11px 15px 12px;transition:border-color .12s ease}
      .dsh-oq-row:hover{border-color:var(--dsw-alias-border-l2)}
      .dsh-oq-row[aria-busy="true"]{opacity:.72}
      .dsh-oq-rowTop{display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px 10px;min-width:0}
      .dsh-oq-rowTitle{flex:1 1 200px;min-width:0;margin:0;font-size:14px;font-weight:500;line-height:22px;overflow-wrap:anywhere}
      .dsh-oq-rowActions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:2px;flex:none;margin-left:auto}
      .dsh-oq-badge{display:inline-flex;align-items:center;gap:5px;flex:none;margin-top:2px;height:20px;padding:0 8px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:18px;white-space:nowrap}
      .dsh-oq-badge::before{content:'';flex:none;width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.75}
      .dsh-oq-badge[data-status="running"]{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);color:var(--dsw-alias-state-business-primary)}
      .dsh-oq-badge[data-status="running"]::before{animation:dsh-oq-pulse 1.8s ease-in-out infinite}
      .dsh-oq-badge[data-status="done"]{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 13%, transparent);color:var(--dsw-alias-state-success-primary)}
      .dsh-oq-badge[data-status="failed"]{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 11%, transparent);color:var(--dsw-alias-state-error-primary)}
      .dsh-oq-badge[data-status="cancelled"]{background:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);color:var(--dsw-alias-label-secondary)}
      .dsh-oq-badge[data-status="cancelled"]::before{background:var(--dsw-alias-state-idle-primary);opacity:1}

      .dsh-oq-meta{display:flex;flex-wrap:wrap;align-items:center;gap:2px 10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
      .dsh-oq-metaItem{display:inline-flex;align-items:center;gap:4px;min-width:0;max-width:100%;overflow-wrap:anywhere}
      .dsh-oq-metaItem--strong{color:var(--dsw-alias-label-primary)}
      .dsh-oq-metaSep{color:var(--dsw-alias-border-l2);user-select:none}
      .dsh-oq-error{display:flex;align-items:flex-start;gap:6px;margin:1px 0 0;border-radius:8px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent);padding:5px 9px;color:var(--dsw-alias-state-error-primary);font-size:12.5px;line-height:19px;overflow-wrap:anywhere}
      .dsh-oq-errorLabel{flex:none;font-weight:500}


      .dsh-oq-modalLayer{position:fixed;inset:0;z-index:55;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:clamp(14px,5vh,36px) 16px;background:rgba(0,0,0,.45);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);pointer-events:auto}
      .dsh-oq-modal{display:flex;flex-direction:column;width:min(560px,100%);max-height:100%;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 24px 64px rgba(0,0,0,.35),0 4px 16px rgba(0,0,0,.22);overflow:hidden}
      .dsh-oq-modal:focus{outline:none}
      .dsh-oq-modalHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;box-sizing:border-box;padding:16px 20px 13px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
      .dsh-oq-modalHeadText{min-width:0}
      .dsh-oq-modalTitle{margin:0;font-size:15px;font-weight:600;line-height:22px}
      .dsh-oq-modalSub{margin:3px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
      .dsh-oq-modalBody{flex:1 1 auto;min-height:0;box-sizing:border-box;overflow:auto;padding:18px 20px;display:flex;flex-direction:column;gap:20px}
      .dsh-oq-modalFoot{display:flex;align-items:center;gap:8px;box-sizing:border-box;padding:12px 20px 14px;border-top:0.5px solid var(--dsw-alias-border-l1)}
      .dsh-oq-modalFootStatus{flex:1 1 auto;min-width:0}
      .dsh-oq-settingsGroup{display:flex;flex-direction:column;gap:8px;min-width:0}

      .dsh-oq-stepper{display:inline-flex;align-items:stretch;align-self:flex-start;height:32px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);transition:border-color .12s ease, box-shadow .12s ease}
      .dsh-oq-stepper:focus-within{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent)}
      .dsh-oq-stepBtn{flex:none;width:30px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:15px;line-height:1;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:background .12s ease,color .12s ease}
      .dsh-oq-stepBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .dsh-oq-stepBtn:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}
      .dsh-oq-stepBtn:disabled{cursor:not-allowed;opacity:.45}
      .dsh-oq-stepBtn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px;border-radius:6px}
      .dsh-oq-stepValue{width:46px;border:0;border-left:0.5px solid var(--dsw-alias-border-l1);border-right:0.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:center;font-variant-numeric:tabular-nums;-moz-appearance:textfield;appearance:textfield}
      .dsh-oq-stepValue::-webkit-outer-spin-button,.dsh-oq-stepValue::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
      .dsh-oq-stepValue:focus{outline:none}
      .dsh-oq-stepValue:disabled{opacity:.6;cursor:not-allowed}

      .dsh-oq-familySwitches{display:flex;flex-direction:column;gap:8px}
      .dsh-oq-familySwitch{display:flex;align-items:center;gap:12px;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px 10px 14px;cursor:pointer;transition:border-color .12s ease,background .12s ease}
      .dsh-oq-familySwitch:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-oq-switch{appearance:none;-webkit-appearance:none;flex:none;order:2;width:34px;height:20px;margin:0;border:0;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);position:relative;cursor:pointer;transition:background .15s ease}
      .dsh-oq-switch::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);box-shadow:0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 25%, transparent);transition:transform .15s ease}
      .dsh-oq-switch:checked{background:var(--dsw-alias-brand-primary)}
      .dsh-oq-switch:checked::after{transform:translateX(14px)}
      .dsh-oq-switch:disabled{cursor:not-allowed;opacity:.5}
      .dsh-oq-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
      .dsh-oq-familySwitchText{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
      .dsh-oq-familySwitchLabel{font-size:13px;font-weight:500;line-height:20px}
      .dsh-oq-familySwitchHint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;overflow-wrap:anywhere}

      .dsh-oq-settingsStatus{margin-left:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
      .dsh-oq-settingsStatus[data-kind="success"]{color:var(--dsw-alias-state-success-primary)}
      .dsh-oq-settingsStatus[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}

      .dsh-oq-loading{display:flex;align-items:center;justify-content:center;gap:9px;padding:48px 8px;color:var(--dsw-alias-label-secondary);font-size:13px}
      .dsh-oq-spinner{flex:none;width:15px;height:15px;border-radius:50%;border:2px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 28%, transparent);border-top-color:var(--dsw-alias-label-secondary);animation:dsh-oq-spin .8s linear infinite}
      .dsh-oq-errorCard{display:flex;flex-direction:column;align-items:flex-start;gap:8px;margin-top:18px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:22px 20px}
      .dsh-oq-errorTitle{margin:0;font-size:14px;font-weight:500;line-height:22px}
      .dsh-oq-errorDetail{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:19px;overflow-wrap:anywhere}

      .dsh-oq-footer{margin-top:30px;border-top:0.5px solid var(--dsw-alias-border-l1);padding-top:13px;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 16px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
      .dsh-oq-footerItem{min-width:0;max-width:100%;overflow-wrap:anywhere}
      .dsh-oq-footerCode{font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;font-size:11px;line-height:17px;overflow-wrap:anywhere}

      @keyframes dsh-oq-spin{to{transform:rotate(360deg)}}
      @keyframes dsh-oq-pulse{0%,100%{opacity:.45;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}

      @media (max-width: 820px){
        .dsh-oq-headButtons{justify-content:flex-start}
        .dsh-oq-statusStrip{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
      }
      @media (max-width: 700px){
        .dsh-oq-content{padding-left:16px;padding-right:16px}
      }
      @media (max-width: 560px){
        .dsh-oq-rowActions{width:100%;justify-content:flex-start;margin-left:0;padding-top:2px}
        .dsh-oq-row{padding:10px 12px 11px}
        .dsh-oq-modalLayer{padding:10px}
        .dsh-oq-modalHead{padding:14px 14px 12px}
        .dsh-oq-modalBody{padding:14px}
        .dsh-oq-modalFoot{padding:11px 14px 12px}
        .dsh-oq-chipMain{flex-wrap:wrap;white-space:normal}
        .dsh-oq-chipCountdown{margin-left:0}
      }
      @media (prefers-reduced-motion: reduce){
        .dsh-oq-badge[data-status="running"]::before,.dsh-oq-spinner{animation:none}
        .dsh-oq-btn,.dsh-oq-row{transition:none}
        .dsh-oq-switch,.dsh-oq-switch::after{transition:none}
      }
    `

    /** Second stylesheet slice: awaiting list, statistics, toasts and new UI pieces. */
    const STYLES_EXTRA = `

      .dsh-oq-armed{margin-top:14px;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:13px 15px 12px}
      .dsh-oq-armedHead{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 12px;margin-bottom:7px}
      .dsh-oq-armedTitle{margin:0;font-size:13px;font-weight:500;line-height:20px}
      .dsh-oq-armedRows{display:flex;flex-direction:column;gap:0;margin:0;padding:0;list-style:none}
      .dsh-oq-armedRow{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;border-top:0.5px solid var(--dsw-alias-border-l1);padding:7px 0}
      .dsh-oq-armedRow:first-child{border-top:0;padding-top:0}
      .dsh-oq-armedRow:last-child{padding-bottom:0}
      .dsh-oq-armedName{flex:1 1 200px;min-width:0;font-size:13px;line-height:20px;overflow-wrap:anywhere}
      .dsh-oq-armedMeta{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
      .dsh-oq-armedActions{display:flex;flex-wrap:wrap;gap:2px;flex:none}
      .dsh-oq-armedError{flex:1 1 100%;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}

      .dsh-oq-savedTag{color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums}

      .dsh-oq-statSection{margin-top:24px}
      .dsh-oq-statHead{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 12px;margin:0 0 9px}
      .dsh-oq-statHeading{display:flex;align-items:baseline;gap:9px;min-width:0;max-width:100%;flex-wrap:wrap}
      .dsh-oq-statTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;white-space:nowrap}
      .dsh-oq-statSub{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
      .dsh-oq-statCards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
      .dsh-oq-statCard{box-sizing:border-box;min-width:0;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:11px 14px 12px}
      .dsh-oq-statCardValue{display:block;font-size:18px;font-weight:600;line-height:26px;font-variant-numeric:tabular-nums;letter-spacing:.01em;overflow-wrap:anywhere}
      .dsh-oq-statCardValue[data-tone="saved"]{color:var(--dsw-alias-state-success-primary)}
      .dsh-oq-statCardValue[data-tone="muted"]{color:var(--dsw-alias-label-secondary)}
      .dsh-oq-statCardLabel{display:block;margin-top:1px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dsh-oq-statPanel{margin-top:8px;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 15px 13px}
      .dsh-oq-chartHead{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:4px 12px}
      .dsh-oq-chartTitle{margin:0;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-primary)}
      .dsh-oq-chartLegend{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
      .dsh-oq-legendItem{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
      .dsh-oq-legendDot{flex:none;width:7px;height:7px;border-radius:2px}
      .dsh-oq-legendDot[data-kind="cost"]{background:var(--dsw-alias-state-business-primary)}
      .dsh-oq-legendDot[data-kind="saved"]{background:var(--dsw-alias-state-success-primary)}
      .dsh-oq-legendDot[data-kind="runs"]{background:var(--dsw-alias-label-tertiary)}
      .dsh-oq-chart{display:block;width:100%;height:auto;margin-top:8px;overflow:visible}
      .dsh-oq-chartBar{transition:opacity .12s ease}
      .dsh-oq-chartBar[data-kind="cost"]{fill:var(--dsw-alias-state-business-primary);opacity:.85}
      .dsh-oq-chartBar[data-kind="saved"]{fill:var(--dsw-alias-state-success-primary);opacity:.85}
      .dsh-oq-chartBar[data-kind="runs"]{fill:var(--dsw-alias-label-tertiary);opacity:.55}
      .dsh-oq-chartBar:hover{opacity:1}
      .dsh-oq-chartGrid{stroke:var(--dsw-alias-border-l1);stroke-width:1}
      .dsh-oq-chartLabel{fill:var(--dsw-alias-label-secondary);font-size:9px;font-family:inherit}
      .dsh-oq-chartEmpty{padding:16px 4px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
      .dsh-oq-tableScroll{overflow-x:auto;margin-top:5px}
      .dsh-oq-statTable{width:100%;border-collapse:collapse;font-size:12px;line-height:18px}
      .dsh-oq-statTable th{padding:4px 8px;border-bottom:0.5px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-weight:500;text-align:left;white-space:nowrap}
      .dsh-oq-statTable td{padding:5px 8px;border-bottom:0.5px solid var(--dsw-alias-border-l1);vertical-align:top;overflow-wrap:anywhere}
      .dsh-oq-statTable tr:last-child td{border-bottom:0}
      .dsh-oq-statTable .dsh-oq-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
      .dsh-oq-pricedTag{color:var(--dsw-alias-state-success-primary);white-space:nowrap}
      .dsh-oq-unpricedTag{color:var(--dsw-alias-label-secondary);white-space:nowrap}
      /* One scroll container holds the header AND the rows, so a scrollbar can
         never make the two grid boxes different widths (the header used to sit
         outside the scroller and drift left of its own column values). */
      .dsh-oq-recentTable{--dsh-oq-recent-cols:minmax(0,1fr) 60px 56px 92px 84px;max-height:252px;overflow-y:auto;overflow-x:hidden;scrollbar-gutter:stable;margin-top:2px}
      .dsh-oq-recentList{list-style:none;margin:0;padding:0}
      .dsh-oq-recentHead{position:sticky;top:0;z-index:1;display:grid;grid-template-columns:var(--dsh-oq-recent-cols);column-gap:12px;padding:4px 0 5px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}
      .dsh-oq-recentHeadCell{min-width:0}
      .dsh-oq-recentRow{display:grid;grid-template-columns:var(--dsh-oq-recent-cols);align-items:baseline;column-gap:12px;border-top:0.5px solid var(--dsw-alias-border-l1);padding:6px 0}
      .dsh-oq-recentRow:first-child{border-top:0}
      .dsh-oq-recentTitle{min-width:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
      .dsh-oq-recentMeta{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap;font-variant-numeric:tabular-nums}
      .dsh-oq-recentMeta--start{justify-self:start;text-align:left}
      .dsh-oq-recentSaved{justify-self:start;text-align:left;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;white-space:nowrap;font-variant-numeric:tabular-nums}
      .dsh-oq-recentSaved--empty{color:var(--dsw-alias-label-secondary)}
      .dsh-oq-runStatus{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:nowrap}
      .dsh-oq-runStatus[data-status="done"]{color:var(--dsw-alias-state-success-primary)}
      .dsh-oq-runStatus[data-status="failed"]{color:var(--dsw-alias-state-error-primary)}
      .dsh-oq-statFootnote{margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;overflow-wrap:anywhere}
      .dsh-oq-statError{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;border-radius:10px;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 7%, transparent);padding:8px 12px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
      .dsh-oq-statLoading{display:flex;align-items:center;gap:8px;padding:18px 2px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}


      .dsh-oq-toastLayer{position:fixed;top:calc(14px + var(--dsh-frame-top-clearance, 0px));left:0;right:0;z-index:60;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:6px;box-sizing:border-box;padding:0 16px;pointer-events:none}
      .dsh-oq-toast{display:flex;align-items:flex-start;gap:7px;box-sizing:border-box;max-width:min(92vw, 440px);border:0.5px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 4px 16px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent);padding:7px 12px;font-size:13px;line-height:19px;pointer-events:auto;overflow-wrap:anywhere}
      .dsh-oq-toastDot{flex:none;width:7px;height:7px;margin-top:6px;border-radius:50%;background:var(--dsw-alias-label-secondary)}
      .dsh-oq-toast[data-kind="success"] .dsh-oq-toastDot{background:var(--dsw-alias-state-success-primary)}
      .dsh-oq-toast[data-kind="warn"] .dsh-oq-toastDot{background:var(--dsw-alias-state-warn-primary)}
      .dsh-oq-toast[data-kind="error"] .dsh-oq-toastDot{background:var(--dsw-alias-state-error-primary)}

      .dsh-oq-sessionMark{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:var(--dsw-alias-state-business-primary)}

      @media (max-width: 820px){
        .dsh-oq-statCards{grid-template-columns:repeat(auto-fit,minmax(130px,1fr))}
      }
      @media (max-width: 700px){
        .dsh-oq-armedActions{width:100%;justify-content:flex-start}
        .dsh-oq-armedActions .dsh-oq-btn{flex:0 0 auto}
        .dsh-oq-chartLabel{font-size:8px}
      }
      @media (max-width: 560px){
        .dsh-oq-statCardValue{font-size:16px;line-height:23px}
        .dsh-oq-statTable th,.dsh-oq-statTable td{padding-left:4px;padding-right:4px}
        .dsh-oq-recentMeta{white-space:normal}
      }
      @media (prefers-reduced-motion: reduce){
        .dsh-oq-chartBar{transition:none}
      }

      .dsh-oq-armedChip{display:inline-flex;align-items:center;gap:4px;flex:none;height:28px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-size:13px;font-weight:500;line-height:20px;cursor:pointer}
      .dsh-oq-armedChip:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-business-tertiary), var(--dsw-alias-state-business-primary) 6%)}
      .dsh-oq-armedChip:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
      .dsh-oq-armedChip:disabled{opacity:.6;cursor:default}
      .dsh-oq-armedChipLabel{white-space:nowrap}
      .dsh-oq-entryGlyph{position:relative;display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%}
      .dsh-oq-entryDot{position:absolute;top:-1px;right:-1px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 1.5px var(--dsw-alias-bg-layer-1)}
      .dsh-oq-row--compact{padding:9px 13px 10px;gap:4px}
      .dsh-oq-rowTitleButton{margin:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-size:14px;font-weight:500;line-height:22px;text-align:left;cursor:pointer;overflow-wrap:anywhere}
      .dsh-oq-rowTitleButton:hover{color:var(--dsw-alias-state-business-primary)}
      .dsh-oq-rowTitleButton:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:4px}
      .dsh-oq-rowError{margin:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}

      /* The chat content column's own width — the exact box the in-conversation
         「插件状态更新」 trigger card and every tool card use. The dock slot is
         wider than that column (it spans the whole composer seat), so the bar
         caps itself at the column width and centers instead of filling the
         slot; nothing here invents a pixel value. */
      .dsh-oq-taskBar{box-sizing:border-box;display:flex;flex-direction:column;margin:0 auto;width:100%;max-width:var(--dsh-chat-content-width, 748px);border:0.5px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);font-size:13px;line-height:20px;overflow:hidden}
      .dsh-oq-taskBarHead{display:flex;align-items:center;gap:6px;box-sizing:border-box;min-width:0;border:0;border-radius:inherit;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:20px;text-align:left;padding:5px 10px 5px 6px;cursor:pointer}
      .dsh-oq-taskBarHead:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-oq-taskBarHead:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
      .dsh-oq-taskBarGlyph{display:inline-flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px;border-radius:6px;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);color:var(--dsw-alias-state-business-primary)}
      .dsh-oq-taskBar[data-status="running"] .dsh-oq-taskBarGlyph{animation:dsh-oq-glyphPulse 1.8s ease-in-out infinite}
      .dsh-oq-taskBar[data-status="cancelled"] .dsh-oq-taskBarGlyph{background:color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent);color:var(--dsw-alias-state-idle-primary)}
      .dsh-oq-taskBar[data-status="failed"] .dsh-oq-taskBarGlyph{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 11%, transparent);color:var(--dsw-alias-state-error-primary)}
      .dsh-oq-taskBarText{flex:none;font-weight:500;color:var(--dsw-alias-label-primary);white-space:nowrap}
      .dsh-oq-taskBarTitle{min-width:0;flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
      .dsh-oq-taskBarMeta{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}
      .dsh-oq-taskBarChevron{display:inline-flex;align-items:center;flex:none;margin-left:1px;color:var(--dsw-alias-label-secondary);transition:transform .14s ease}
      .dsh-oq-taskBar[data-expanded="true"] .dsh-oq-taskBarChevron{transform:rotate(180deg)}
      .dsh-oq-taskBarBody{display:flex;flex-direction:column;gap:7px;border-top:0.5px solid var(--dsw-alias-border-l1);padding:8px 10px 9px}
      .dsh-oq-taskBarDesc{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
      .dsh-oq-taskBarActions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:4px}
      .dsh-oq-taskBarError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
      @keyframes dsh-oq-glyphPulse{0%,100%{opacity:.6}50%{opacity:1}}

      .dsh-oq-createBar{display:flex;flex-wrap:wrap;align-items:center;gap:10px 12px;box-sizing:border-box;margin-top:16px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1)}
      .dsh-oq-createField{display:flex;align-items:center;gap:8px;min-width:0;flex:1 1 260px}
      .dsh-oq-createLabel{flex:none;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .dsh-oq-createButton{flex:none;height:32px}
      .dsh-oq-createError{flex:1 1 100%;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}

      .dsh-oq-picker{position:relative;display:flex;flex:1 1 auto;min-width:170px;max-width:320px}
      .dsh-oq-pickerButton{box-sizing:border-box;display:flex;align-items:center;gap:6px;width:100%;min-width:0;height:32px;padding:0 8px 0 10px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;transition:border-color .12s ease, box-shadow .12s ease}
      .dsh-oq-pickerButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-oq-pickerButton:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
      .dsh-oq-pickerButton:disabled{opacity:.5;cursor:not-allowed}
      .dsh-oq-pickerButton[data-open="true"]{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent)}
      .dsh-oq-pickerValue{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-oq-pickerChevron{display:inline-flex;align-items:center;flex:none;color:var(--dsw-alias-label-secondary);transition:transform .14s ease}
      .dsh-oq-pickerButton[data-open="true"] .dsh-oq-pickerChevron{transform:rotate(180deg)}
      .dsh-oq-pickerPop{position:absolute;top:calc(100% + 6px);left:0;z-index:30;box-sizing:border-box;display:flex;flex-direction:column;min-width:240px;width:100%;border:0.5px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-overlay);box-shadow:0 10px 28px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);padding:6px}
      .dsh-oq-pickerSearch{display:flex;align-items:center;gap:6px;box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);padding:0 8px;color:var(--dsw-alias-label-secondary)}
      .dsh-oq-pickerSearchIcon{display:inline-flex;align-items:center;flex:none}
      .dsh-oq-pickerInput{flex:1 1 auto;min-width:0;height:28px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
      .dsh-oq-pickerInput::placeholder{color:var(--dsw-alias-label-secondary);opacity:.7}
      .dsh-oq-pickerList{margin:6px 0 0;padding:0;list-style:none;max-height:228px;overflow:auto;scrollbar-gutter:stable}
      .dsh-oq-pickerOption{display:flex;align-items:center;gap:7px;box-sizing:border-box;border-radius:7px;padding:5px 8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;cursor:pointer}
      .dsh-oq-pickerOption[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-oq-pickerOption[aria-selected="true"] .dsh-oq-pickerOptionLabel{font-weight:500}
      .dsh-oq-pickerCheck{display:inline-flex;align-items:center;justify-content:center;flex:none;width:13px;color:var(--dsw-alias-state-business-primary)}
      .dsh-oq-pickerOptionLabel{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-oq-pickerEmpty{margin:0;padding:10px 8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:center}
      .dsh-oq-tabs{display:flex;gap:4px;margin-top:20px;border-bottom:0.5px solid var(--dsw-alias-border-l1)}
      .dsh-oq-tab{position:relative;display:inline-flex;align-items:center;gap:6px;padding:8px 10px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;font-weight:500;line-height:20px;cursor:pointer}
      .dsh-oq-tab:hover{color:var(--dsw-alias-label-primary)}
      .dsh-oq-tab[data-active="true"]{color:var(--dsw-alias-label-primary)}
      .dsh-oq-tab[data-active="true"]::after{content:'';position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px;background:var(--dsw-alias-state-business-primary)}
      .dsh-oq-tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:6px}
      .dsh-oq-tabCount{min-width:18px;box-sizing:border-box;padding:0 5px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}
      .dsh-oq-subtabs{display:flex;flex-wrap:wrap;gap:6px;margin:14px 0 12px}
      .dsh-oq-subtab{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;cursor:pointer}
      .dsh-oq-subtab:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-oq-subtab[data-active="true"]{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}
      .dsh-oq-subtab[data-active="true"] .dsh-oq-subtabCount{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);color:var(--dsw-alias-state-business-primary)}
      .dsh-oq-subtab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
      .dsh-oq-subtabCount{min-width:18px;box-sizing:border-box;padding:0 5px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;line-height:18px;text-align:center;font-variant-numeric:tabular-nums}
      .dsh-oq-listEmpty{margin:24px 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;text-align:center}
    `


    // ────────────────────────────────────────────────────────────────────────
    // Icons
    // ────────────────────────────────────────────────────────────────────────

    /** Sidebar glyph: crescent moon + queue rows (inherits currentColor). */
    function OffpeakIcon({ size }) {
      const edge = typeof size === 'number' ? size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: edge,
          height: edge,
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('path', {
          d: 'M13.4 3.6a8.1 8.1 0 1 0 6.4 12.6 6.6 6.6 0 0 1-6.4-12.6Z',
          fill: 'currentColor',
          opacity: 0.88,
        }),
        h('rect', { x: 15.2, y: 9, width: 6.4, height: 1.6, rx: 0.8, fill: 'currentColor', opacity: 0.9 }),
        h('rect', { x: 15.2, y: 12.4, width: 4.6, height: 1.6, rx: 0.8, fill: 'currentColor', opacity: 0.62 }),
        h('rect', { x: 15.2, y: 15.8, width: 3, height: 1.6, rx: 0.8, fill: 'currentColor', opacity: 0.4 }),
      )
    }

    /** Small close glyph for the settings header. */
    function CloseIcon({ size }) {
      const edge = typeof size === 'number' ? size : 14
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: edge, height: edge, fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M4 4l8 8M12 4l-8 8',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
        }),
      )
    }

    /** Down chevron used by the collapsible task bar and the workspace picker. */
    function ChevronIcon({ size }) {
      const edge = typeof size === 'number' ? size : 14
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: edge, height: edge, fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M4.2 6.2 8 10l3.8-3.8',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /** Magnifier glyph inside the workspace picker search field. */
    function SearchIcon({ size }) {
      const edge = typeof size === 'number' ? size : 13
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: edge, height: edge, fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('circle', { cx: 7, cy: 7, r: 4.3, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M10.3 10.3 14 14', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      )
    }

    /** Check glyph marking the selected workspace. */
    function CheckIcon({ size }) {
      const edge = typeof size === 'number' ? size : 13
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: edge, height: edge, fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M3.4 8.4 6.4 11.4 12.6 4.9',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    /**
     * Isolated countdown: only this component re-renders every second.
     *
     * @param {{ target?: number, offset?: number, t: Function, onExpire?: Function }} props - countdown props.
     * @returns {import('react').ReactElement} countdown text.
     */
    function Countdown({ target, offset, t, onExpire }) {
      const [, tick] = React.useReducer((value) => value + 1, 0)
      const expired = React.useRef(false)
      const hasTarget = typeof target === 'number' && Number.isFinite(target)

      React.useEffect(() => {
        if (!hasTarget) return undefined
        const timer = setInterval(() => tick(), COUNTDOWN_MS)
        return () => clearInterval(timer)
      }, [hasTarget])

      React.useEffect(() => {
        expired.current = false
      }, [target])

      React.useEffect(() => {
        if (!hasTarget || expired.current) return
        if (target - (Date.now() + numberOr(offset, 0)) <= 0) {
          expired.current = true
          if (typeof onExpire === 'function') onExpire()
        }
      })

      if (!hasTarget) return null
      const remaining = target - (Date.now() + numberOr(offset, 0))
      return h('span', { className: 'dsh-oq-chipCountdown' }, t('period.switchIn', { time: formatCountdown(remaining) }))
    }

    /** Live billing chip for one model family: dot, label, countdown, subline. */
    function BillingChip({ label, zone, period: chipPeriod, snapshot, t, onExpire }) {
      const period = chipPeriod
      const now = nowOf(snapshot)
      const hasPeriod = !!period && typeof period === 'object'
      const isPeak = hasPeriod && period.kind === 'peak'

      let subline = t('period.loading')
      if (hasPeriod) {
        if (isPeak) {
          subline = typeof period.nextOffpeakAt === 'number' && Number.isFinite(period.nextOffpeakAt)
            ? t('period.nextOffpeak', { time: formatWhen(period.nextOffpeakAt, t, zone, now) })
            : t('period.peakOpen')
        } else if (typeof period.windowEndAt === 'number' && Number.isFinite(period.windowEndAt)) {
          const suffix =
            period.reason === 'weekend'
              ? ` · ${t('period.weekendShort')}`
              : period.reason === 'holiday'
                ? ` · ${t('period.holidayShort')}`
                : ''
          const endAt = period.windowEndAt
          const sameDay = dateKeyDiff(zoneDateKey(endAt, zone), zoneDateKey(now, zone)) === 0
          const endLabel = sameDay ? formatClock(endAt, t, zone) : formatWhen(endAt, t, zone, now)
          subline = `${t('period.offpeakUntil', { time: endLabel })}${suffix}`
        } else {
          subline = t('period.offpeakOpen')
        }
      }

      const tone = !hasPeriod ? 'idle' : isPeak ? 'peak' : 'offpeak'
      return h(
        'div',
        { className: 'dsh-oq-chip' },
        h(
          'div',
          { className: 'dsh-oq-chipMain' },
          h('span', {
            className: !hasPeriod ? 'dsh-oq-dot dsh-oq-dot--idle' : isPeak ? 'dsh-oq-dot dsh-oq-dot--peak' : 'dsh-oq-dot',
            'aria-hidden': 'true',
          }),
          h('span', { className: 'dsh-oq-chipFamily' }, label),
          h('span', { className: 'dsh-oq-chipPeriod', 'data-tone': tone }, !hasPeriod ? t('period.loading') : isPeak ? t('period.peak') : t('period.offpeak')),
          hasPeriod && typeof period.nextChangeAt === 'number'
            ? h(Countdown, { target: period.nextChangeAt, offset: snapshot && snapshot.serverOffset, t, onExpire })
            : null,
        ),
        h('div', { className: 'dsh-oq-chipSub', 'data-tone': tone }, subline),
      )
    }

    /**
     * Searchable workspace dropdown: a button that opens a popover with a filter
     * field and the workspace list. Keyboard: ↑/↓ move, Enter picks, Esc closes.
     *
     * @param {{ id?: string, value: string, options: Array<{id: string, label: string, hint?: string}>, disabled?: boolean, t: Function, onChange: Function }} props - picker props.
     * @returns {import('react').ReactElement} picker.
     */
    function WorkspacePicker({ id, value, options, disabled, t, onChange }) {
      const [open, setOpen] = React.useState(false)
      const [query, setQuery] = React.useState('')
      const [active, setActive] = React.useState(0)
      const rootRef = React.useRef(null)
      const listRef = React.useRef(null)
      const buttonRef = React.useRef(null)

      const needle = query.trim().toLowerCase()
      const filtered =
        needle === ''
          ? options
          : options.filter((option) =>
              `${option.label} ${option.hint || ''}`.toLowerCase().includes(needle),
            )
      const selected = options.find((option) => option.id === value)

      // Close on a click outside the trigger + popover.
      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const root = rootRef.current
          if (root && event.target instanceof Node && root.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown, true)
        return () => document.removeEventListener('mousedown', onPointerDown, true)
      }, [open])

      // Keep the highlighted row inside the scroll viewport.
      React.useEffect(() => {
        if (!open) return
        const list = listRef.current
        const item = list && list.children ? list.children[active] : null
        if (item && typeof item.scrollIntoView === 'function') item.scrollIntoView({ block: 'nearest' })
      }, [open, active])

      const show = () => {
        if (disabled) return
        const index = options.findIndex((option) => option.id === value)
        setQuery('')
        setActive(index < 0 ? 0 : index)
        setOpen(true)
      }

      const hide = () => {
        setOpen(false)
        if (buttonRef.current && typeof buttonRef.current.focus === 'function') buttonRef.current.focus()
      }

      const choose = (option) => {
        if (!option) return
        onChange(option.id)
        hide()
      }

      const onKeyDown = (event) => {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setActive((current) => (filtered.length === 0 ? 0 : Math.min(current + 1, filtered.length - 1)))
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setActive((current) => Math.max(0, current - 1))
          return
        }
        if (event.key === 'Enter') {
          event.preventDefault()
          choose(filtered[active])
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          hide()
          return
        }
        if (event.key === 'Tab') setOpen(false)
      }

      return h(
        'div',
        { className: 'dsh-oq-picker', ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            id,
            ref: buttonRef,
            className: 'dsh-oq-pickerButton',
            'data-open': open ? 'true' : undefined,
            disabled: disabled === true,
            'aria-haspopup': 'listbox',
            'aria-expanded': open ? 'true' : 'false',
            title: selected ? selected.hint || selected.label : t('create.noWorkspaceOption'),
            onClick: () => (open ? hide() : show()),
          },
          h('span', { className: 'dsh-oq-pickerValue' }, selected ? selected.label : t('create.noWorkspaceOption')),
          h('span', { className: 'dsh-oq-pickerChevron' }, h(ChevronIcon, { size: 13 })),
        ),
        open
          ? h(
              'div',
              { className: 'dsh-oq-pickerPop' },
              h(
                'div',
                { className: 'dsh-oq-pickerSearch' },
                h('span', { className: 'dsh-oq-pickerSearchIcon' }, h(SearchIcon, { size: 13 })),
                h('input', {
                  className: 'dsh-oq-pickerInput',
                  type: 'text',
                  autoFocus: true,
                  value: query,
                  placeholder: t('create.search'),
                  'aria-label': t('create.search'),
                  onChange: (event) => {
                    setQuery(event.target.value)
                    setActive(0)
                  },
                  onKeyDown,
                }),
              ),
              filtered.length === 0
                ? h('p', { className: 'dsh-oq-pickerEmpty' }, t('create.noMatch'))
                : h(
                    'ul',
                    { className: 'dsh-oq-pickerList', role: 'listbox', 'aria-label': t('create.workspace'), ref: listRef },
                    filtered.map((option, index) =>
                      h(
                        'li',
                        {
                          key: option.id || option.label,
                          className: 'dsh-oq-pickerOption',
                          role: 'option',
                          'aria-selected': option.id === value ? 'true' : 'false',
                          'data-active': index === active ? 'true' : undefined,
                          title: option.hint || option.label,
                          onMouseEnter: () => setActive(index),
                          onClick: () => choose(option),
                        },
                        h(
                          'span',
                          { className: 'dsh-oq-pickerCheck', 'aria-hidden': 'true' },
                          option.id === value ? h(CheckIcon, { size: 13 }) : null,
                        ),
                        h('span', { className: 'dsh-oq-pickerOptionLabel' }, option.label),
                      ),
                    ),
                  ),
            )
          : null,
      )
    }

    /** Inline notice row. */
    function Notice({ kind, children }) {
      return h(
        'div',
        { className: 'dsh-oq-notice', 'data-kind': kind, role: 'status' },
        h('span', { className: 'dsh-oq-noticeDot', 'aria-hidden': 'true' }),
        h('span', null, children),
      )
    }

    // ────────────────────────────────────────────────────────────────────────
    // Composer entry points: armed chip + creation toast watcher
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Compact chip in the composer toolbar while the conversation is armed.
     * Clicking it cancels the armed creation; nothing sits above the composer.
     *
     * @param {{ store: object, t: Function, sessionId: string, toasts: object }} props - chip props.
     * @returns {import('react').ReactElement|null} chip or null.
     */
    function ComposerArmedChip({ store, t, sessionId, toasts }) {
      const snapshot = useSnapshot(store)
      const arm = listOf(pick(snapshot.data, 'armed')).find((entry) => pick(entry, 'sessionId') === sessionId)
      const armed = arm !== undefined
      const updating = armed && pick(arm, 'mode') === 'update'
      const [busy, setBusy] = React.useState(false)
      // A just-submitted task removes the arm; poll fast so the chip and the
      // task bar swap within a second instead of a full poll interval.
      React.useEffect(() => {
        if (!armed) return undefined
        return store.retainFast()
      }, [store, armed])
      if (!armed) return null
      const cancel = async () => {
        if (busy) return
        setBusy(true)
        try {
          await store.mutate(disarmPath(sessionId), {})
          toasts.push('success', t('toast.disarmed'))
        } catch (error) {
          toasts.push('error', t('toast.failed', { message: messageOf(error) }))
        } finally {
          setBusy(false)
        }
      }
      return h(
        'button',
        {
          type: 'button',
          className: 'dsh-oq-armedChip',
          'data-mode': updating ? 'update' : 'create',
          title: updating ? t('chip.cancelUpdate') : t('chip.cancel'),
          'aria-label': updating ? t('chip.cancelUpdate') : t('chip.cancel'),
          onClick: () => void cancel(),
          disabled: busy,
        },
        h(OffpeakIcon, { size: 14 }),
        h('span', { className: 'dsh-oq-armedChipLabel' }, busy ? t('chip.cancelling') : updating ? t('chip.updating') : t('chip.armed')),
        h(CloseIcon, { size: 12 }),
      )
    }

    /**
     * Keeps the images pasted into an armed conversation across Session
     * navigation, and renders nothing.
     *
     * DSH persists a draft as text only — a draft attachment is a browser-only
     * object URL owned by the Session's input shell — so switching away from an
     * armed conversation and coming back through the panel restored the text
     * but dropped every image. While the conversation stays armed this keeps
     * the `File` objects and re-attaches them to the restored draft, so nothing
     * has to be pasted twice.
     *
     * @param {{
     *   sessionId: string,
     *   input: { attachmentIds?: unknown } | undefined,
     *   inputActions: { addAttachments?: Function } | undefined,
     *   store: object,
     *   toasts: object,
     *   t: Function,
     *   draftMemory: object,
     * }} props - session, composer state and plugin helpers.
     * @returns {null} renders nothing.
     */
    function OffpeakDraftKeeper({ sessionId, input, inputActions, store, toasts, t, draftMemory }) {
      const snapshot = useSnapshot(store)
      const armed = listOf(pick(snapshot.data, 'armed')).some((entry) => pick(entry, 'sessionId') === sessionId)
      const ids = listOf(input && input.attachmentIds).filter((id) => typeof id === 'string')
      const key = ids.join(',')
      const attemptFor = React.useRef('')
      const attempts = React.useRef(0)
      const hadAttachments = React.useRef(false)
      React.useEffect(() => {
        if (sessionId === '' || draftMemory === undefined) return
        if (attemptFor.current !== sessionId) {
          attemptFor.current = sessionId
          attempts.current = 0
          hadAttachments.current = false
        }
        if (!armed) {
          draftMemory.forget(sessionId)
          return
        }
        if (key !== '') {
          hadAttachments.current = true
          draftMemory.capture(sessionId, ids)
          return
        }
        if (hadAttachments.current) {
          // Every attachment was removed on purpose: forget the copy as well.
          hadAttachments.current = false
          draftMemory.forget(sessionId)
          return
        }
        if (attempts.current >= 2) return
        attempts.current += 1
        const restored = draftMemory.restore(sessionId, inputActions)
        if (restored > 0) toasts.push('success', t('toast.imagesKept', { n: restored }))
      }, [sessionId, armed, key])
      return null
    }

    // ────────────────────────────────────────────────────────────────────────
    // Conversation task bar: create/queue/cancel state + edit controls
    // ────────────────────────────────────────────────────────────────────────

    /** localStorage key holding task ids whose finished bar was dismissed. */
    const DISMISSED_KEY = 'dsh.offpeak.dismissedTasks.v3'

    /** Read the dismissed finished-task ids (bounded). */
    function dismissedTaskIds() {
      try {
        const raw = window.localStorage.getItem(DISMISSED_KEY)
        const parsed = raw === null ? [] : JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []
      } catch {
        return []
      }
    }

    /** Remember one dismissed finished task. */
    function dismissTaskId(id) {
      try {
        const next = [...dismissedTaskIds().filter((entry) => entry !== id), id].slice(-100)
        window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
      } catch {
        /* private mode or a full quota must not break the bar */
      }
    }

    /**
     * Compact status bar above the composer for the task bound to this
     * conversation: created/waiting, running, cancelled or failed. Queued tasks
     * can be edited or cancelled here; cancelled/failed tasks can be retried,
     * deleted or dismissed, so a panel-side cancel is visible in the
     * conversation too.
     *
     * @param {{ store: object, t: Function, sessionId: string }} props - bar props.
     * @returns {import('react').ReactElement|null} bar or null.
     */
    function BoundTaskBar({ store, t, sessionId, inputActions, input, onEditTask, toasts }) {
      const snapshot = useSnapshot(store)
      const data = snapshot.data
      const now = nowOf(snapshot)
      const [pending, setPending] = React.useState('')
      const [error, setError] = React.useState('')
      const [confirmDelete, setConfirmDelete] = React.useState(false)
      const [dismissed, setDismissed] = React.useState(() => dismissedTaskIds())
      const [expanded, setExpanded] = React.useState(false)

      React.useEffect(() => {
        if (!confirmDelete) return undefined
        const timer = setTimeout(() => setConfirmDelete(false), CONFIRM_MS)
        return () => clearTimeout(timer)
      }, [confirmDelete])

      // Keep the bar in step with execution/cancel transitions.
      React.useEffect(() => {
        const active = listOf(pick(snapshot.data, 'tasks')).some(
          (entry) => pick(entry, 'sourceSessionId') === sessionId && isActiveTask(entry),
        )
        if (!active) return undefined
        return store.retainFast()
      }, [store, snapshot.data, sessionId])

      const tasks = data ? listOf(pick(data, 'tasks')).filter((task) => pick(task, 'sourceSessionId') === sessionId) : []
      const live = tasks
        .filter((task) => isActiveTask(task))
        .sort((left, right) => {
          const rank = (task) => (pick(task, 'status') === 'running' ? 0 : 1)
          return rank(left) - rank(right) || numberOr(pick(left, 'order'), 0) - numberOr(pick(right, 'order'), 0)
        })
      let selected = live[0]
      if (selected === undefined) {
        const latest = tasks
          .filter((entry) => {
            const status = pick(entry, 'status')
            return status === 'cancelled' || status === 'failed'
          })
          .sort((left, right) => numberOr(pick(right, 'updatedAt'), 0) - numberOr(pick(left, 'updatedAt'), 0))
        selected = latest.find((entry) => !dismissed.includes(String(pick(entry, 'id'))))
      }
      const taskId = selected === undefined ? '' : String(pick(selected, 'id'))
      const status = selected && ['queued', 'running', 'cancelled', 'failed'].includes(pick(selected, 'status')) ? selected.status : 'queued'

      // A cancelled/failed task opens its detail + actions by default; a live
      // task stays a single compact line until the user asks for more.
      React.useEffect(() => {
        setExpanded(status === 'cancelled' || status === 'failed')
      }, [taskId, status])

      if (!data || selected === undefined) return null
      const task = selected
      const titleText = (() => {
        const value = pick(task, 'title')
        if (typeof value === 'string' && value.trim()) return value.trim()
        const prompt = pick(task, 'prompt')
        return typeof prompt === 'string' && prompt.trim() ? prompt.trim().split('\n')[0].slice(0, 80) : ''
      })()
      const promptText = typeof pick(task, 'prompt') === 'string' ? task.prompt : ''
      const errorText = typeof pick(task, 'error') === 'string' ? task.error : ''
      const timing = timingOfTask(task, data, t, now)
      // A running task shows a clock instead of the sentence "已运行 3 分钟":
      // the pill's dot already says it is live, and a clock never reflows.
      const runningFor = status === 'running' ? formatClock(now - numberOr(pick(task, 'startedAt'), now)) : ''
      const metaText = runningFor !== '' ? runningFor : timing.text
      const label =
        status === 'queued'
          ? t('taskBar.created')
          : status === 'running'
            ? t('taskBar.running')
            : status === 'cancelled'
              ? t('taskBar.cancelled')
              : t('taskBar.failed')
      const more = tasks.length - 1
      const bodyId = 'dsh-oq-task-bar-body'
      const promptTrimmed = promptText.trim()
      // The header already shows the title; repeat the prompt only when it adds
      // information (a longer body the one-line header truncates).
      const showDesc = promptTrimmed !== '' && promptTrimmed !== titleText

      const mutate = async (name, path, body) => {
        if (pending !== '') return
        setPending(name)
        setError('')
        setConfirmDelete(false)
        try {
          await store.mutate(path, body === undefined ? {} : body)
          if (name === 'retry') {
            const next = dismissed.filter((entry) => entry !== taskId)
            setDismissed(next)
            try {
              window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
            } catch {
              /* ignored */
            }
          }
        } catch (reason) {
          setError(messageOf(reason))
        } finally {
          setPending('')
        }
      }

      // Editing returns to the composer: the queued task is re-armed as an
      // update target and its text is put back into the draft, so the user can
      // rewrite it (and attach images) exactly like a normal chat message.
      const startEdit = async () => {
        if (pending !== '' || typeof onEditTask !== 'function') return
        const draft = input && typeof input.draft === 'string' ? input.draft : ''
        if (draft.trim() !== '') {
          toasts.push('warn', t('taskBar.draftConflict'))
          return
        }
        setPending('edit')
        setError('')
        try {
          await onEditTask(task)
          if (inputActions && typeof inputActions.setDraft === 'function') inputActions.setDraft(promptText)
        } catch (reason) {
          setError(messageOf(reason))
        } finally {
          setPending('')
        }
      }

      const dismiss = () => {
        dismissTaskId(taskId)
        setDismissed([...dismissed, taskId])
      }

      const button = (key, labelText, onClick, options = {}) =>
        h(
          'button',
          {
            key,
            type: 'button',
            className: `dsh-oq-btn dsh-oq-btn--sm ${options.className || 'dsh-oq-btn--ghost'}`.trim(),
            onClick,
            disabled: pending !== '' || options.disabled === true,
            title: options.title,
            'aria-label': options.ariaLabel,
          },
          pending === options.pendingKey ? t('taskBar.pending') : labelText,
        )

      const actions = []
      if (status === 'queued') {
        actions.push(button('edit', t('taskBar.edit'), () => void startEdit(), { pendingKey: 'edit' }))
        actions.push(button('cancel', t('taskBar.cancel'), () => void mutate('cancel', taskPath(task, 'cancel'))))
      } else if (status === 'running') {
        actions.push(button('cancel', t('taskBar.cancel'), () => void mutate('cancel', taskPath(task, 'cancel'))))
      } else if (status === 'cancelled' || status === 'failed') {
        actions.push(button('retry', t('taskBar.retry'), () => void mutate('retry', taskPath(task, 'retry')), { pendingKey: 'retry' }))
        actions.push(
          button(
            'delete',
            confirmDelete ? t('taskBar.confirmDelete') : t('taskBar.delete'),
            () => {
              if (!confirmDelete) {
                setConfirmDelete(true)
                return
              }
              void mutate('delete', taskPath(task, 'delete'))
            },
            { className: confirmDelete ? 'dsh-oq-btn--dangerArmed' : 'dsh-oq-btn--danger', title: confirmDelete ? t('row.confirmHint') : undefined },
          ),
        )
        actions.push(button('dismiss', '×', dismiss, { className: 'dsh-oq-btn--ghost dsh-oq-btn--icon', title: t('taskBar.dismiss'), ariaLabel: t('taskBar.dismiss') }))
      }

      return h(
        'div',
        { className: 'dsh-oq-taskBar', 'data-status': status, 'data-expanded': expanded ? 'true' : 'false', role: 'group', 'aria-label': t('taskBar.aria') },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-oq-taskBarHead',
            'aria-expanded': expanded ? 'true' : 'false',
            'aria-controls': bodyId,
            title: expanded ? t('taskBar.collapse') : t('taskBar.expand'),
            onClick: () => setExpanded((open) => !open),
          },
          h('span', { className: 'dsh-oq-taskBarGlyph', 'aria-hidden': 'true' }, h(OffpeakIcon, { size: 13 })),
          h('span', { className: 'dsh-oq-taskBarText' }, label),
          h('span', { className: 'dsh-oq-familyTag' }, familyLabelOf(familyOfTask(task), t)),
          titleText ? h('span', { className: 'dsh-oq-taskBarTitle' }, titleText) : null,
          metaText !== '' ? h('span', { className: 'dsh-oq-taskBarMeta' }, metaText) : null,
          more > 0 ? h('span', { className: 'dsh-oq-taskBarMeta' }, t('taskBar.more', { n: more })) : null,
          h('span', { className: 'dsh-oq-taskBarChevron' }, h(ChevronIcon, { size: 14 })),
        ),
        expanded
          ? h(
              'div',
              { className: 'dsh-oq-taskBarBody', id: bodyId },
              showDesc ? h('p', { className: 'dsh-oq-taskBarDesc', title: promptTrimmed }, promptTrimmed) : null,
              error ? h('p', { className: 'dsh-oq-taskBarError', role: 'status' }, error) : null,
              status === 'failed' && errorText !== '' ? h('p', { className: 'dsh-oq-taskBarError', role: 'status', title: errorText }, errorText) : null,
              actions.length > 0 ? h('div', { className: 'dsh-oq-taskBarActions' }, actions) : null,
            )
          : null,
      )
    }

    /**
     * Announces tasks that appear in a snapshot after this page loaded. A
     * zero-call creation ends without an assistant reply, so the queue jump is
     * otherwise silent; the toast says where the task went.
     *
     * @param {{ store: object, toasts: object, t: Function }} props - watcher props.
     * @returns {null} renders nothing.
     */
    function OffpeakTaskWatcher({ store, toasts, t }) {
      const snapshot = useSnapshot(store)
      const knownRef = React.useRef(null)
      const data = snapshot.data
      React.useEffect(() => {
        if (snapshot.phase === 'loading' || !data) return
        const tasks = listOf(pick(data, 'tasks'))
        const promptOf = (task) => (typeof pick(task, 'prompt') === 'string' ? task.prompt : '')
        if (knownRef.current === null) {
          knownRef.current = new Map(tasks.map((task) => [String(pick(task, 'id')), promptOf(task)]))
          return
        }
        const known = knownRef.current
        let newest
        let updated
        for (const task of tasks) {
          const id = String(pick(task, 'id'))
          const prompt = promptOf(task)
          if (!known.has(id)) {
            known.set(id, prompt)
            if (newest === undefined || numberOr(pick(task, 'createdAt'), 0) > numberOr(pick(newest, 'createdAt'), 0)) newest = task
            continue
          }
          if (known.get(id) !== prompt) {
            known.set(id, prompt)
            if (pick(task, 'status') === 'queued') updated = task
          }
        }
        if (newest !== undefined) {
          const nextRunAt = pick(newest, 'nextRunAt')
          const settings = settingsOf(data)
          const now = nowOf(snapshot)
          toasts.push(
            'success',
            typeof nextRunAt === 'number' && Number.isFinite(nextRunAt) && settings.autoRun !== false
              ? nextRunAt - now <= 10000
                ? t('toast.queuedNow')
                : t('toast.queued', { time: formatWhen(nextRunAt, t, settings.timeZone, now) })
              : t('toast.queuedNoTime'),
          )
          return
        }
        if (updated !== undefined) toasts.push('success', t('toast.updated'))
      }, [data, snapshot.phase, snapshot.receivedAt, snapshot.serverOffset, store, toasts, t])
      return null
    }

    // ────────────────────────────────────────────────────────────────────────
    // App-level toast layer
    // ────────────────────────────────────────────────────────────────────────

    /**
     * The conversation column the toast stack centers on. The overlay layer
     * spans the whole frame (sidebar included), so a viewport-centered toast
     * sits visibly left of the chat column.
     *
     * @returns {HTMLElement|null} the conversation column, or null on a page view.
     */
    function toastAnchor() {
      const target = document.querySelector('[data-conversation-content]')
      if (!(target instanceof HTMLElement)) return null
      return target.getBoundingClientRect().width > 0 ? target : null
    }

    /**
     * Center one toast layer inside the conversation column, falling back to
     * the whole viewport on a full-page view.
     *
     * @param {HTMLElement|null} layer - the fixed overlay layer.
     * @returns {void}
     */
    function placeToastLayer(layer) {
      if (layer === null) return
      const anchor = toastAnchor()
      const rect = anchor === null ? null : anchor.getBoundingClientRect()
      layer.style.left = rect === null ? '0px' : `${Math.max(0, Math.round(rect.left))}px`
      layer.style.width = rect === null ? '100%' : `${Math.round(rect.width)}px`
      layer.style.right = 'auto'
    }

    /**
     * Toast overlay rendered in `shell.overlay`; the store is fed by the
     * creation watcher and the composer command.
     *
     * @param {{ store: object }} props - injected toast store.
     * @returns {import('react').ReactElement|null} toast layer.
     */
    function OffpeakToasts({ store }) {
      const toasts = useStore(store)
      const visible = Array.isArray(toasts) && toasts.length > 0
      // A callback ref places the layer before the first paint, so the toast
      // never flashes at the viewport center.
      const attachLayer = React.useCallback((node) => {
        placeToastLayer(node)
      }, [])
      React.useEffect(() => {
        if (!visible) return undefined
        const place = () => placeToastLayer(document.querySelector('.dsh-oq-toastLayer'))
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
      }, [visible])
      if (!visible) return null
      return h(
        'div',
        { className: 'dsh-oq-toastLayer', ref: attachLayer, role: 'status', 'aria-live': 'polite' },
        toasts.map((toast) =>
          h(
            'div',
            { className: 'dsh-oq-toast', 'data-kind': toast.kind, key: toast.id },
            h('span', { className: 'dsh-oq-toastDot', 'aria-hidden': 'true' }),
            h('span', null, toast.text),
          ),
        ),
      )
    }

    // ────────────────────────────────────────────────────────────────────────
    // Panel pieces: awaiting-creation list, task rows, groups, empty state
    // ────────────────────────────────────────────────────────────────────────

    /** Workspace display title for one workspace id. */
    function workspaceTitleOf(workspaces, workspaceId) {
      const found = listOf(workspaces).find((workspace) => pick(workspace, 'id') === workspaceId)
      if (!found) return typeof workspaceId === 'string' && workspaceId ? workspaceId : '—'
      const title = pick(found, 'title')
      if (typeof title === 'string' && title) return title
      const path = pick(found, 'path')
      return typeof path === 'string' && path ? baseName(path) : String(workspaceId)
    }

    /**
     * Conversations already armed for zero-call creation, with open/disarm actions.
     *
     * @param {{ data: object, store: object, t: Function, now: number, onOpenSession: Function, sessionLabel: Function }} props - list props.
     * @returns {import('react').ReactElement|null} awaiting-creation card.
     */
    function ArmedList({ data, store, t, now, onOpenSession, sessionLabel }) {
      const armed = listOf(pick(data, 'armed'))
      const [busyId, setBusyId] = React.useState('')
      const [error, setError] = React.useState('')
      if (armed.length === 0) return null
      const zone = settingsOf(data).timeZone
      const workspaces = listOf(pick(data, 'workspaces'))
      const labelOf = (sessionId, workspaceId) => {
        const label = typeof sessionLabel === 'function' ? sessionLabel(sessionId) : ''
        return label || workspaceTitleOf(workspaces, workspaceId)
      }

      const disarm = async (sessionId) => {
        if (busyId) return
        setBusyId(sessionId)
        setError('')
        try {
          await store.mutate(disarmPath(sessionId), {})
        } catch (reason) {
          setError(messageOf(reason))
        } finally {
          setBusyId('')
        }
      }

      return h(
        'section',
        { className: 'dsh-oq-armed', 'aria-label': t('armed.aria') },
        h(
          'div',
          { className: 'dsh-oq-armedHead' },
          h('h2', { className: 'dsh-oq-armedTitle' }, t('armed.title')),
        ),
        h(
          'ul',
          { className: 'dsh-oq-armedRows' },
          armed.map((entry) => {
            const sessionId = String(pick(entry, 'sessionId') || '')
            const workspaceId = pick(entry, 'workspaceId')
            const armedAt = pick(entry, 'armedAt')
            const lastError = typeof pick(entry, 'lastError') === 'string' ? entry.lastError : ''
            return h(
              'li',
              { className: 'dsh-oq-armedRow', key: sessionId },
              h('span', { className: 'dsh-oq-armedName' }, labelOf(sessionId, workspaceId)),
              pick(entry, 'mode') === 'update' ? h('span', { className: 'dsh-oq-armedMeta' }, t('armed.updateMode')) : null,
              typeof armedAt === 'number' && Number.isFinite(armedAt)
                ? h('span', { className: 'dsh-oq-armedMeta' }, formatWhen(armedAt, t, zone, now))
                : null,
              h(
                'span',
                { className: 'dsh-oq-armedActions' },
                h(
                  'button',
                  { type: 'button', className: 'dsh-oq-btn dsh-oq-btn--link dsh-oq-btn--sm', onClick: () => onOpenSession(sessionId) },
                  t('armed.open'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-oq-btn dsh-oq-btn--ghost dsh-oq-btn--sm',
                    onClick: () => void disarm(sessionId),
                    disabled: busyId !== '',
                  },
                  t('armed.cancel'),
                ),
              ),
              lastError ? h('span', { className: 'dsh-oq-armedError', role: 'status' }, t('armed.error', { message: lastError })) : null,
            )
          }),
        ),
        error ? h('p', { className: 'dsh-oq-armedError', role: 'status' }, error) : null,
      )
    }

    /**
     * One compact queue row: status, title (opens the source conversation),
     * timing, savings, and the actions valid for its status. Everything else —
     * the prompt, the answer, failures — lives in the conversation itself.
     *
     * @param {object} props - row props.
     * @returns {import('react').ReactElement} row.
     */
    function TaskRow({ task, data, store, t, now, onOpenSession, onStatsRefresh }) {
      const status = typeof pick(task, 'status') === 'string' ? task.status : 'queued'
      const statusSafe = ['queued', 'running', 'done', 'failed', 'cancelled'].includes(status) ? status : 'queued'
      const title = (() => {
        const value = pick(task, 'title')
        if (typeof value === 'string' && value.trim()) return value.trim()
        const prompt = pick(task, 'prompt')
        if (typeof prompt === 'string' && prompt.trim()) return prompt.trim().split('\n')[0].slice(0, 80)
        return t('row.pending')
      })()
      const errorText = typeof pick(task, 'error') === 'string' ? task.error : ''
      const sourceSessionId = typeof pick(task, 'sourceSessionId') === 'string' ? task.sourceSessionId : ''
      const sourceTitle = typeof pick(task, 'sourceSessionTitle') === 'string' ? task.sourceSessionTitle : ''

      const [pending, setPending] = React.useState('')
      const [actionError, setActionError] = React.useState('')
      const [confirmDelete, setConfirmDelete] = React.useState(false)

      React.useEffect(() => {
        if (!confirmDelete) return undefined
        const timer = setTimeout(() => setConfirmDelete(false), CONFIRM_MS)
        return () => clearTimeout(timer)
      }, [confirmDelete])

      const run = async (name, path) => {
        if (pending) return
        setPending(name)
        setActionError('')
        setConfirmDelete(false)
        try {
          await store.mutate(path, {})
          const changesRuns = name === 'start' || name === 'retry' || name === 'cancel'
          if (changesRuns && typeof onStatsRefresh === 'function') onStatsRefresh()
        } catch (reason) {
          setActionError(messageOf(reason))
        } finally {
          setPending('')
        }
      }

      const busy = pending !== ''
      const button = (options) =>
        h(
          'button',
          {
            key: options.key,
            type: 'button',
            className: `dsh-oq-btn dsh-oq-btn--sm ${options.className || ''}`.trim(),
            onClick: options.onClick,
            disabled: busy || options.disabled === true,
            'aria-label': options.ariaLabel,
            title: options.title,
          },
          options.children,
        )

      const actions = []
      if (statusSafe === 'queued') {
        actions.push(
          button({
            key: 'start',
            className: 'dsh-oq-btn--ghost',
            onClick: () => void run('start', taskPath(task, 'start')),
            children: pending === 'start' ? t('row.starting') : t('row.start'),
          }),
        )
      }
      if (statusSafe === 'queued' || statusSafe === 'running') {
        actions.push(
          button({
            key: 'cancel',
            className: 'dsh-oq-btn--ghost',
            onClick: () => void run('cancel', taskPath(task, 'cancel')),
            children: t('row.cancel'),
          }),
        )
      }
      if (statusSafe === 'failed' || statusSafe === 'cancelled') {
        actions.push(
          button({
            key: 'retry',
            className: 'dsh-oq-btn--ghost',
            onClick: () => void run('retry', taskPath(task, 'retry')),
            children: t('row.retry'),
          }),
        )
      }
      if (statusSafe !== 'running') {
        actions.push(
          button({
            key: 'delete',
            className: confirmDelete ? 'dsh-oq-btn--dangerArmed' : 'dsh-oq-btn--danger',
            title: confirmDelete ? t('row.confirmHint') : undefined,
            onClick: () => {
              if (!confirmDelete) {
                setConfirmDelete(true)
                return
              }
              void run('delete', taskPath(task, 'delete'))
            },
            children: confirmDelete ? t('row.confirmDelete') : t('row.delete'),
          }),
        )
      }

      const timing = timingOfTask(task, data, t, now)
      const savings = statusSafe === 'done' || statusSafe === 'failed' || statusSafe === 'cancelled' ? savingsOfTask(task, t) : null
      const openTitle = sourceTitle ? `${t('row.openSource')}：${sourceTitle}` : t('row.openSource')

      return h(
        'li',
        { className: 'dsh-oq-row dsh-oq-row--compact', 'data-status': statusSafe, 'aria-busy': busy ? 'true' : undefined },
        h(
          'div',
          { className: 'dsh-oq-rowTop' },
          h('span', { className: 'dsh-oq-badge', 'data-status': statusSafe }, statusLabel(t, statusSafe)),
          h('span', { className: 'dsh-oq-familyTag' }, familyLabelOf(familyOfTask(task), t)),
          sourceSessionId
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-oq-rowTitle dsh-oq-rowTitleButton',
                  title: openTitle,
                  'aria-label': openTitle,
                  onClick: () => onOpenSession(sourceSessionId),
                },
                title,
              )
            : h('h3', { className: 'dsh-oq-rowTitle' }, title),
          actions.length > 0 ? h('div', { className: 'dsh-oq-rowActions' }, actions) : null,
        ),
        h(
          'div',
          { className: 'dsh-oq-meta' },
          h('span', { className: timing.strong ? 'dsh-oq-metaItem dsh-oq-metaItem--strong' : 'dsh-oq-metaItem' }, timing.text),
          savings
            ? h(
                React.Fragment,
                null,
                h('span', { className: 'dsh-oq-metaSep', 'aria-hidden': 'true' }, '·'),
                h('span', { className: savings.kind === 'saved' ? 'dsh-oq-metaItem dsh-oq-savedTag' : 'dsh-oq-metaItem' }, savings.text),
              )
            : null,
        ),
        statusSafe === 'failed' && errorText ? h('p', { className: 'dsh-oq-rowError', title: errorText }, errorText) : null,
        actionError
          ? h('p', { className: 'dsh-oq-error', role: 'status' }, h('span', { className: 'dsh-oq-errorLabel' }, t('row.errorLabel')), h('span', null, actionError))
          : null,
      )
    }

    // ────────────────────────────────────────────────────────────────────────
    // Statistics section (savings, zero-call creations, 14-day chart, models)
    // ────────────────────────────────────────────────────────────────────────

    /** Small donut-free bar chart of the last `days` days, drawn with inline SVG. */
    function SavingsChart({ series, t }) {
      const days = series.length
      const max = seriesMax(series)
      let maxRuns = 0
      for (const day of series) maxRuns = Math.max(maxRuns, numberOr(pick(day, 'runs'), 0))
      const width = 560
      const height = 128
      const padLeft = 38
      const padRight = 4
      const padTop = 8
      const padBottom = 18
      const plotWidth = width - padLeft - padRight
      const plotHeight = height - padTop - padBottom
      const slot = plotWidth / Math.max(1, days)
      const barWidth = Math.max(3, Math.min(12, slot * 0.4))
      const scale = (value) => (max <= 0 ? 0 : (value / max) * plotHeight)
      const ticks = max <= 0 ? [0] : [0, max / 2, max]
      const labelEvery = days > 10 ? 3 : days > 6 ? 2 : 1

      const bars = []
      series.forEach((day, index) => {
        const groupX = padLeft + slot * index + slot / 2
        const savedHeight = scale(day.saved)
        const runs = numberOr(pick(day, 'runs'), 0)
        const runsHeight = maxRuns > 0 ? (runs / maxRuns) * plotHeight : 0
        const baseY = padTop + plotHeight
        const tooltip = `${day.date} · ${t('statistics.legendSaved')} ${formatCny(day.saved)} · ${t('statistics.legendRuns')} ${runs}`
        if (runs > 0) {
          // A subtle backdrop bar shows run activity even on days whose runs
          // were unpriced in CNY (GLM-only days still light up).
          bars.push(
            h(
              'rect',
              {
                key: `runs-${day.date}`,
                className: 'dsh-oq-chartBar',
                'data-kind': 'runs',
                x: groupX - barWidth / 2 - barWidth * 0.75,
                y: baseY - Math.max(1, runsHeight),
                width: barWidth * 0.5,
                height: Math.max(1, runsHeight),
                rx: 1.5,
              },
              h('title', null, tooltip),
            ),
          )
        }
        if (day.saved > 0) {
          bars.push(
            h(
              'rect',
              {
                key: `saved-${day.date}`,
                className: 'dsh-oq-chartBar',
                'data-kind': 'saved',
                x: groupX - barWidth / 2,
                y: baseY - Math.max(1, savedHeight),
                width: barWidth,
                height: Math.max(1, savedHeight),
                rx: 1.5,
              },
              h('title', null, tooltip),
            ),
          )
        }
        if (index % labelEvery === 0 || index === days - 1) {
          bars.push(
            h(
              'text',
              {
                key: `label-${day.date}`,
                className: 'dsh-oq-chartLabel',
                x: groupX,
                y: height - 4,
                textAnchor: 'middle',
              },
              day.date.slice(5),
            ),
          )
        }
      })

      const grid = ticks.map((tick, index) =>
        h('line', {
          key: `grid-${index}`,
          className: 'dsh-oq-chartGrid',
          x1: padLeft,
          x2: width - padRight,
          y1: padTop + plotHeight - scale(tick),
          y2: padTop + plotHeight - scale(tick),
        }),
      )
      const yLabels = ticks.map((tick, index) =>
        h(
          'text',
          {
            key: `ylab-${index}`,
            className: 'dsh-oq-chartLabel',
            x: padLeft - 4,
            y: padTop + plotHeight - scale(tick) + 3,
            textAnchor: 'end',
          },
          formatCny(tick),
        ),
      )

      return h(
        'svg',
        {
          className: 'dsh-oq-chart',
          viewBox: `0 0 ${width} ${height}`,
          role: 'img',
          'aria-label': t('statistics.chartTitle'),
        },
        grid,
        yLabels,
        bars,
      )
    }

    /**
     * The panel statistics section: savings cards, zero-call creation count,
     * a 14-day chart, per-model totals, recent runs and the estimate disclaimer.
     *
     * @param {{ statsStore: object, data: object, t: Function }} props - section props.
     * @returns {import('react').ReactElement} statistics block.
     */
    function StatsSection({ statsStore, data, t }) {
      const stats = useStore(statsStore)
      const payload = stats.data
      const zone = settingsOf(data).timeZone
      const now = Date.now()
      const currentMonth = String(zoneDateKey(Date.now(), zone)).slice(0, 7)

      const finishedCount =
        numberOr(pick(pick(data, 'counts'), 'done'), 0) + numberOr(pick(pick(data, 'counts'), 'failed'), 0)
      const previousFinished = React.useRef(undefined)
      React.useEffect(() => {
        if (previousFinished.current !== undefined && previousFinished.current !== finishedCount) {
          void statsStore.refresh()
        }
        previousFinished.current = finishedCount
      }, [finishedCount, statsStore])

      const lifetime = pick(payload, 'lifetime') || {}
      const byDay = listOf(pick(payload, 'byDay'))
      const days = numberOr(pick(payload, 'days'), 14)
      const series = buildDaySeries(byDay, Math.max(1, days), now, zone)
      const monthSaved = byDay.reduce((total, entry) => {
        const date = typeof pick(entry, 'date') === 'string' ? entry.date : ''
        return date.startsWith(currentMonth) ? total + numberOr(pick(entry, 'saved'), 0) : total
      }, 0)
      const lifetimeSaved = numberOr(pick(lifetime, 'saved'), 0)
      const familyRuns = pick(lifetime, 'familyRuns') || {}
      const glmPoints = numberOr(pick(lifetime, 'glmPoints'), 0)
      const glmPointsSaved = numberOr(pick(lifetime, 'glmPointsSaved'), 0)
      const byModel = listOf(pick(payload, 'byModel'))
      const recentRuns = listOf(pick(payload, 'recentRuns'))
      const pricesVerifiedAt = typeof pick(payload, 'pricesVerifiedAt') === 'string' ? payload.pricesVerifiedAt : ''

      const cards = [
        { key: 'lifetimeSaved', value: formatCny(lifetimeSaved), label: t('statistics.lifetimeSaved'), tone: 'saved' },
        { key: 'monthSaved', value: formatCny(monthSaved), label: t('statistics.monthSaved'), tone: 'saved' },
        { key: 'runsDeepseek', value: String(numberOr(pick(familyRuns, 'deepseek'), 0)), label: t('statistics.familyRuns', { family: familyLabelOf('deepseek', t) }), tone: undefined },
        { key: 'runsGlm', value: String(numberOr(pick(familyRuns, 'glm'), 0)), label: t('statistics.familyRuns', { family: familyLabelOf('glm', t) }), tone: undefined },
      ]
      if (glmPoints > 0) {
        cards.push({ key: 'glmPoints', value: formatPoints(glmPoints), label: t('statistics.glmPoints'), tone: undefined })
      }
      if (glmPointsSaved > 0) {
        cards.push({ key: 'glmPointsSaved', value: formatPoints(glmPointsSaved), label: t('statistics.glmPointsSaved'), tone: 'saved' })
      }

      const triggerText = (trigger) => (trigger === 'manual' ? t('statistics.trigger.manual') : t('statistics.trigger.offpeak'))

      return h(
        'section',
        { className: 'dsh-oq-statSection', 'aria-label': t('statistics.title') },
        h(
          'div',
          { className: 'dsh-oq-statHead' },
          h(
            'div',
            { className: 'dsh-oq-statHeading' },
            h('h2', { className: 'dsh-oq-statTitle' }, t('statistics.title')),
            h('span', { className: 'dsh-oq-statSub' }, t('statistics.subtitle')),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-oq-btn dsh-oq-btn--ghost dsh-oq-btn--sm',
              onClick: () => void statsStore.refresh(),
              'aria-label': t('statistics.refresh'),
              title: t('statistics.refresh'),
            },
            t('action.refresh'),
          ),
        ),
        stats.phase === 'loading' && !payload
          ? h(
              'div',
              { className: 'dsh-oq-statLoading', role: 'status' },
              h('span', { className: 'dsh-oq-spinner', 'aria-hidden': 'true' }),
              h('span', null, t('statistics.loading')),
            )
          : null,
        stats.phase === 'error' && !payload
          ? h(
              'div',
              { className: 'dsh-oq-statError', role: 'status' },
              h('span', null, t('statistics.error')),
              h('button', { type: 'button', className: 'dsh-oq-btn dsh-oq-btn--outline dsh-oq-btn--sm', onClick: () => void statsStore.refresh() }, t('statistics.retry')),
            )
          : null,
        payload
          ? h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'dsh-oq-statCards' },
                cards.map((card) =>
                  h(
                    'div',
                    { className: 'dsh-oq-statCard', key: card.key },
                    h('span', { className: 'dsh-oq-statCardValue', 'data-tone': card.tone }, card.value),
                    h('span', { className: 'dsh-oq-statCardLabel' }, card.label),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'dsh-oq-statPanel' },
                h(
                  'div',
                  { className: 'dsh-oq-chartHead' },
                  h('h3', { className: 'dsh-oq-chartTitle' }, t('statistics.chartTitle')),
                  h(
                    'div',
                    { className: 'dsh-oq-chartLegend' },
                    h(
                      'span',
                      { className: 'dsh-oq-legendItem' },
                      h('span', { className: 'dsh-oq-legendDot', 'data-kind': 'saved', 'aria-hidden': 'true' }),
                      t('statistics.legendSaved'),
                    ),
                    h(
                      'span',
                      { className: 'dsh-oq-legendItem' },
                      h('span', { className: 'dsh-oq-legendDot', 'data-kind': 'runs', 'aria-hidden': 'true' }),
                      t('statistics.legendRuns'),
                    ),
                  ),
                ),
                seriesMax(series) <= 0 && series.every((day) => numberOr(pick(day, 'runs'), 0) === 0)
                  ? h('p', { className: 'dsh-oq-chartEmpty' }, t('statistics.chartEmpty'))
                  : h(SavingsChart, { series, t }),
              ),
              h(
                'div',
                { className: 'dsh-oq-statPanel' },
                h('h3', { className: 'dsh-oq-chartTitle' }, t('statistics.byModel')),
                byModel.length === 0
                  ? h('p', { className: 'dsh-oq-chartEmpty' }, t('statistics.recentEmpty'))
                  : h(
                      'div',
                      { className: 'dsh-oq-tableScroll' },
                      h(
                        'table',
                        { className: 'dsh-oq-statTable' },
                        h(
                          'thead',
                          null,
                          h(
                            'tr',
                            null,
                            h('th', null, t('statistics.tableModel')),
                            h('th', { className: 'dsh-oq-num' }, t('statistics.tableRuns')),
                            h('th', { className: 'dsh-oq-num' }, t('statistics.tableSaved')),
                            h('th', { className: 'dsh-oq-num' }, t('statistics.tablePoints')),
                            h('th', { className: 'dsh-oq-num' }, t('statistics.tableTokens')),
                            h('th', null, t('statistics.tablePriced')),
                          ),
                        ),
                        h(
                          'tbody',
                          null,
                          byModel.map((entry, index) => {
                            const rawModel = typeof pick(entry, 'model') === 'string' ? entry.model : ''
                            const rawProvider = typeof pick(entry, 'provider') === 'string' ? entry.provider : ''
                            const unknown = !rawModel || rawModel === 'unknown'
                            const model = unknown ? t('statistics.unknownModel') : rawModel
                            const provider = unknown || rawProvider === 'unknown' ? '' : rawProvider
                            const unpriced = pick(entry, 'unpriced') === true
                            const familyId = familyOfTask(entry)
                            const points = pick(entry, 'points')
                            const tokens = numberOr(pick(entry, 'tokensIn'), 0) + numberOr(pick(entry, 'tokensOut'), 0)
                            return h(
                              'tr',
                              { key: `model-${index}-${model}-${provider}` },
                              h(
                                'td',
                                null,
                                h('span', { className: 'dsh-oq-familyTag' }, familyLabelOf(familyId, t)),
                                ' ',
                                model,
                                provider ? h('span', { className: 'dsh-oq-recentMeta' }, ` · ${provider}`) : null,
                              ),
                              h('td', { className: 'dsh-oq-num' }, String(numberOr(pick(entry, 'runs'), 0))),
                              h('td', { className: 'dsh-oq-num' }, unpriced && familyId !== 'glm' ? '—' : formatCny(numberOr(pick(entry, 'saved'), 0))),
                              h('td', { className: 'dsh-oq-num' }, typeof points === 'number' ? formatPoints(points) : '—'),
                              h('td', { className: 'dsh-oq-num' }, formatTokens(tokens)),
                              h(
                                'td',
                                null,
                                familyId === 'glm'
                                  ? h('span', { className: 'dsh-oq-pricedTag' }, t('statistics.pointsTag'))
                                  : unpriced
                                    ? h('span', { className: 'dsh-oq-unpricedTag' }, t('statistics.unpricedTag'))
                                    : h('span', { className: 'dsh-oq-pricedTag' }, t('statistics.tablePriced')),
                              ),
                            )
                          }),
                        ),
                      ),
                    ),
              ),
              h(
                'div',
                { className: 'dsh-oq-statPanel' },
                h('h3', { className: 'dsh-oq-chartTitle' }, t('statistics.recent')),
                recentRuns.length === 0
                  ? h('p', { className: 'dsh-oq-chartEmpty' }, t('statistics.recentEmpty'))
                  : h(
                      'div',
                      { className: 'dsh-oq-recentTable' },
                      h(
                        'div',
                        { className: 'dsh-oq-recentHead', 'aria-hidden': 'true' },
                        h('span', { className: 'dsh-oq-recentHeadCell' }, t('statistics.colTask')),
                        h('span', { className: 'dsh-oq-recentHeadCell' }, t('statistics.colStatus')),
                        h('span', { className: 'dsh-oq-recentHeadCell' }, t('statistics.colTrigger')),
                        h('span', { className: 'dsh-oq-recentHeadCell' }, t('statistics.colTime')),
                        h('span', { className: 'dsh-oq-recentHeadCell' }, t('statistics.colSaved')),
                      ),
                      h(
                        'ul',
                        { className: 'dsh-oq-recentList' },
                        recentRuns.map((run, index) => {
                          const title = typeof pick(run, 'title') === 'string' && run.title ? run.title : '—'
                          const finishedAt = pick(run, 'finishedAt')
                          const saved = numberOr(pick(run, 'saved'), 0)
                          const unpriced = pick(run, 'unpriced') === true
                          const status = typeof pick(run, 'status') === 'string' ? run.status : ''
                          const timeText =
                            typeof finishedAt === 'number' && Number.isFinite(finishedAt) ? formatWhen(finishedAt, t, zone, now) : ''
                          // Every row emits the same five cells so the columns line
                          // up across rows no matter which fields are present.
                          return h(
                            'li',
                            { className: 'dsh-oq-recentRow', key: `run-${index}-${pick(run, 'id') || finishedAt}` },
                            h(
                              'span',
                              { className: 'dsh-oq-recentTitle' },
                              h('span', { className: 'dsh-oq-familyTag' }, familyLabelOf(familyOfTask(run), t)),
                              ' ',
                              title,
                            ),
                            h(
                              'span',
                              { className: 'dsh-oq-runStatus', 'data-status': status || undefined },
                              status ? statusLabel(t, status) : '',
                            ),
                            h('span', { className: 'dsh-oq-recentMeta dsh-oq-recentMeta--start' }, triggerText(pick(run, 'trigger'))),
                            h('span', { className: 'dsh-oq-recentMeta' }, timeText),
                            familyOfTask(run) === 'glm'
                              ? (() => {
                                  const pointsSaved = numberOr(pick(run, 'pointsSaved'), 0)
                                  const points = pick(run, 'points')
                                  if (pointsSaved > 0) return h('span', { className: 'dsh-oq-recentSaved' }, `+${formatPoints(pointsSaved)}`)
                                  if (typeof points !== 'number') {
                                    return h('span', { className: 'dsh-oq-recentSaved dsh-oq-recentSaved--empty' }, t('statistics.unpricedTag'))
                                  }
                                  return h('span', { className: 'dsh-oq-recentSaved dsh-oq-recentSaved--empty' }, '')
                                })()
                              : unpriced
                                ? h('span', { className: 'dsh-oq-recentSaved dsh-oq-recentSaved--empty' }, t('statistics.unpricedTag'))
                                : saved > 0
                                  ? h('span', { className: 'dsh-oq-recentSaved' }, `+${formatCny(saved)}`)
                                  : h('span', { className: 'dsh-oq-recentSaved dsh-oq-recentSaved--empty' }, ''),
                          )
                        }),
                      ),
                    ),
              ),
              h(
                'p',
                { className: 'dsh-oq-statFootnote' },
                t('statistics.disclaimer'),
                pricesVerifiedAt ? ` · ${t('statistics.pricesVerified', { date: pricesVerifiedAt })}` : '',
              ),
            )
          : null,
      )
    }

    // ────────────────────────────────────────────────────────────────────────
    // Settings section
    // ────────────────────────────────────────────────────────────────────────

    /** One labelled settings field with an optional hint and error line. */
    function SettingsField({ id, label, hint, error, children }) {
      return h(
        'div',
        { className: 'dsh-oq-field' },
        h('label', { className: 'dsh-oq-label', htmlFor: id }, label),
        children,
        hint ? h('span', { className: 'dsh-oq-labelHint' }, hint) : null,
        error ? h('span', { className: 'dsh-oq-fieldError', role: 'status' }, error) : null,
      )
    }

    /**
     * Settings modal: a centered dialog over the page with a dimmed backdrop,
     * rendered through the shell.overlay slot so its fixed positioning is
     * framed against the whole window like the plugin's toasts. Keeps a local
     * draft so polling never overwrites what the user is typing. Closes on
     * Escape, the ✕ button or a backdrop click; traps Tab focus and restores
     * it to the opener on close.
     *
     * @param {{ data: object, store: object, t: Function, onClose: Function }} props - settings props.
     * @returns {import('react').ReactElement} settings dialog.
     */
    function SettingsSection({ data, store, t, onClose }) {
      const settings = settingsOf(data)
      const [form, setForm] = React.useState(() => settingsToForm(settings))
      const [pending, setPending] = React.useState(false)
      const [fieldErrors, setFieldErrors] = React.useState({})
      const [status, setStatus] = React.useState(null)
      const dialogRef = React.useRef(null)
      const onCloseRef = React.useRef(onClose)
      onCloseRef.current = onClose

      const update = (key, value) => {
        setForm((current) => ({ ...current, [key]: value }))
        if (fieldErrors[key]) setFieldErrors((current) => ({ ...current, [key]: undefined }))
        if (status) setStatus(null)
      }

      const save = async () => {
        if (pending) return
        const built = buildSettingsBody(form, t)
        setFieldErrors(built.errors)
        setStatus(null)
        if (!built.body) return
        setPending(true)
        try {
          const result = await store.mutate('/settings', built.body)
          setForm(settingsToForm(settingsOf({ settings: pick(result, 'settings') })))
          setStatus({ kind: 'success', text: t('settings.saved') })
        } catch (reason) {
          setStatus({ kind: 'error', text: messageOf(reason) })
        } finally {
          setPending(false)
        }
      }

      const restoreDefaults = () => {
        setForm(settingsToForm(DEFAULT_SETTINGS))
        setFieldErrors({})
        setStatus({ kind: 'info', text: t('settings.resetHint') })
      }

      const parsedConcurrent = Number.parseInt(form.maxConcurrent, 10)
      const baseConcurrent =
        Number.isInteger(parsedConcurrent) && parsedConcurrent >= 1 && parsedConcurrent <= 5
          ? parsedConcurrent
          : numberOr(DEFAULT_SETTINGS.maxConcurrent, 1)
      const stepConcurrent = (delta) => {
        update('maxConcurrent', String(Math.min(5, Math.max(1, baseConcurrent + delta))))
      }

      // Focus the dialog, close on Escape and keep Tab focus inside while open;
      // on unmount, hand focus back to the element that opened the modal.
      React.useEffect(() => {
        const node = dialogRef.current
        if (node && typeof node.focus === 'function') node.focus({ preventScroll: true })
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCloseRef.current()
            return
          }
          if (event.key !== 'Tab' || !dialogRef.current) return
          const focusables = dialogRef.current.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])')
          if (focusables.length === 0) return
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          const active = document.activeElement
          if (event.shiftKey && (active === first || active === dialogRef.current)) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && active === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        const previous = document.activeElement
        return () => {
          document.removeEventListener('keydown', onKeyDown, true)
          if (previous && typeof previous.focus === 'function') previous.focus()
        }
      }, [])

      return h(
        'div',
        {
          className: 'dsh-oq-modalLayer',
          role: 'presentation',
          onClick: (event) => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'section',
          {
            className: 'dsh-oq-modal',
            id: 'dsh-oq-settings',
            ref: dialogRef,
            tabIndex: -1,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'dsh-oq-settings-title',
          },
          h(
            'header',
            { className: 'dsh-oq-modalHead' },
            h(
              'div',
              { className: 'dsh-oq-modalHeadText' },
              h('h2', { className: 'dsh-oq-modalTitle', id: 'dsh-oq-settings-title' }, t('settings.title')),
              h('p', { className: 'dsh-oq-modalSub' }, t('settings.subtitle')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-oq-btn dsh-oq-btn--ghost dsh-oq-btn--icon dsh-oq-btn--sm',
                onClick: onClose,
                'aria-label': t('action.settingsClose'),
              },
              h(CloseIcon),
            ),
          ),
          h(
            'div',
            { className: 'dsh-oq-modalBody' },
            h(
              'section',
              { className: 'dsh-oq-settingsGroup' },
              h(
                SettingsField,
                { id: 'dsh-oq-setting-concurrent', label: t('settings.maxConcurrent'), hint: t('settings.maxConcurrentHint'), error: fieldErrors.maxConcurrent },
                h(
                  'div',
                  { className: 'dsh-oq-stepper' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-oq-stepBtn',
                      disabled: pending,
                      'aria-label': t('settings.decrease'),
                      onClick: () => stepConcurrent(-1),
                    },
                    '−',
                  ),
                  h('input', {
                    id: 'dsh-oq-setting-concurrent',
                    className: 'dsh-oq-stepValue',
                    type: 'number',
                    min: 1,
                    max: 5,
                    step: 1,
                    inputMode: 'numeric',
                    value: form.maxConcurrent,
                    disabled: pending,
                    'aria-invalid': fieldErrors.maxConcurrent ? 'true' : undefined,
                    onChange: (event) => update('maxConcurrent', event.target.value),
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dsh-oq-stepBtn',
                      disabled: pending,
                      'aria-label': t('settings.increase'),
                      onClick: () => stepConcurrent(1),
                    },
                    '+',
                  ),
                ),
              ),
            ),
            h(
              'section',
              { className: 'dsh-oq-settingsGroup' },
              h(
                'div',
                { className: 'dsh-oq-field' },
                h('span', { className: 'dsh-oq-label', id: 'dsh-oq-setting-families' }, t('settings.models')),
                h('span', { className: 'dsh-oq-labelHint' }, t('settings.modelsHint')),
              ),
              h(
                'div',
                { className: 'dsh-oq-familySwitches', role: 'group', 'aria-labelledby': 'dsh-oq-setting-families' },
                FAMILY_ORDER.map((id) =>
                  h(
                    'label',
                    { key: id, className: 'dsh-oq-familySwitch' },
                    h(
                      'span',
                      { className: 'dsh-oq-familySwitchText' },
                      h('span', { className: 'dsh-oq-familySwitchLabel' }, t(`settings.family.${id}`)),
                      h('span', { className: 'dsh-oq-familySwitchHint' }, t(`settings.family.${id}Hint`)),
                    ),
                    h('input', {
                      type: 'checkbox',
                      className: 'dsh-oq-switch',
                      checked: form.familyEnabled[id] === true,
                      disabled: pending,
                      onChange: (event) =>
                        update('familyEnabled', { ...form.familyEnabled, [id]: event.target.checked }),
                    }),
                  ),
                ),
              ),
            ),
          ),
          h(
            'footer',
            { className: 'dsh-oq-modalFoot' },
            h(
              'button',
              { type: 'button', className: 'dsh-oq-btn dsh-oq-btn--outline', onClick: restoreDefaults, disabled: pending },
              t('settings.reset'),
            ),
            status
              ? h('span', { className: 'dsh-oq-settingsStatus dsh-oq-modalFootStatus', 'data-kind': status.kind, role: 'status' }, status.text)
              : fieldErrors.maxConcurrent
                ? h('span', { className: 'dsh-oq-settingsStatus dsh-oq-modalFootStatus', 'data-kind': 'error', role: 'status' }, fieldErrors.maxConcurrent)
                : h('span', { className: 'dsh-oq-modalFootStatus', 'aria-hidden': 'true' }),
            h('button', { type: 'button', className: 'dsh-oq-btn dsh-oq-btn--primary', disabled: pending, onClick: () => void save() }, pending ? t('settings.saving') : t('settings.save')),
          ),
        ),
      )
    }

    /**
     * Shell-overlay mount for the settings modal: reads the shared flag the
     * management page toggles, so the dialog renders in the frame-wide
     * floating layer instead of inside the page's scroll tree. Waits for the
     * first snapshot so the form never mounts from default settings, and so
     * the dialog node exists when the mount effect focuses it.
     *
     * @param {{ flag: object, store: object, t: Function }} props - bridge props.
     * @returns {import('react').ReactElement|null} modal or null.
     */
    function SettingsModalHost({ flag, store, t }) {
      const open = useStore(flag)
      const snapshot = useSnapshot(store)
      if (!open || !snapshot.data) return null
      return h(SettingsSection, { data: snapshot.data, store, t, onClose: () => flag.set(false) })
    }

    // ────────────────────────────────────────────────────────────────────────
    // Management panel page
    // ────────────────────────────────────────────────────────────────────────

    /**
     * The queue management page: billing chip, awaiting-creation conversations,
     * grouped queue, savings statistics, settings and footer. Creation itself
     * happens in the composer with /闲时任务, so the page has no creation form.
     *
     * @param {object} props - injected stores, handlers and locale `t`.
     * @returns {import('react').ReactElement} page.
     */
    function OffpeakPage({ store, statsStore, seenStore, settingsFlag, t, onOpenSession, sessionLabel, onCreateTask }) {
      const snapshot = useSnapshot(store)
      const data = snapshot.data
      const now = nowOf(snapshot)
      const settingsOpen = useStore(settingsFlag)
      const [workspaceChoice, setWorkspaceChoice] = React.useState('')
      const [creating, setCreating] = React.useState(false)
      const [createError, setCreateError] = React.useState('')
      const [topTab, setTopTab] = React.useState('queue')
      const [statusTab, setStatusTab] = React.useState('all')
      const scrollRef = React.useRef(null)

      const ready = snapshot.phase === 'ready' && !!data
      const workspaces = listOf(pick(data, 'workspaces'))
      const tasks = listOf(pick(data, 'tasks'))
      const counts = pick(data, 'counts')
      const countOf = (key) => numberOr(pick(counts, key), 0)
      const statusTabs = [
        { key: 'all', label: t('stats.all'), count: tasks.length },
        { key: 'queued', label: t('stats.queued'), count: countOf('queued') },
        { key: 'running', label: t('stats.running'), count: countOf('running') },
        { key: 'done', label: t('stats.done'), count: countOf('done') },
        { key: 'failed', label: t('stats.failed'), count: countOf('failed') },
        { key: 'cancelled', label: t('stats.cancelled'), count: countOf('cancelled') },
      ]
      const statusOrder = (task) => numberOr(pick(task, 'order'), 0)
      const statusTime = (task) => numberOr(pick(task, 'updatedAt'), 0)
      const filtered = (() => {
        if (statusTab === 'all') {
          return [...tasks].sort((left, right) => statusTime(right) - statusTime(left))
        }
        if (statusTab === 'cancelled') {
          return tasks.filter((task) => pick(task, 'status') === 'cancelled').sort((left, right) => statusTime(right) - statusTime(left))
        }
        if (statusTab === 'failed') {
          return tasks.filter((task) => pick(task, 'status') === 'failed').sort((left, right) => statusTime(right) - statusTime(left))
        }
        if (statusTab === 'queued') {
          return tasks.filter((task) => pick(task, 'status') === 'queued').sort((left, right) => statusOrder(left) - statusOrder(right))
        }
        if (statusTab === 'running') {
          return tasks
            .filter((task) => pick(task, 'status') === 'running')
            .sort((left, right) => numberOr(pick(left, 'startedAt'), 0) - numberOr(pick(right, 'startedAt'), 0))
        }
        return tasks.filter((task) => pick(task, 'status') === 'done').sort((left, right) => statusTime(right) - statusTime(left))
      })()

      React.useEffect(() => {
        const running = tasks.some((task) => pick(task, 'status') === 'running')
        if (!running) return undefined
        return store.retainFast()
      }, [store, tasks])

      // Looking at the panel clears the sidebar entry's green dot.
      React.useEffect(() => {
        if (!ready) return
        seenStore.mark(now)
      }, [ready, now, seenStore])

      // While the settings modal is open, keep the page scroll still so wheel
      // and touch input cannot move the content behind the backdrop.
      React.useEffect(() => {
        const node = scrollRef.current
        if (!node) return undefined
        if (settingsOpen) node.style.overflow = 'hidden'
        else node.style.removeProperty('overflow')
        return () => {
          node.style.removeProperty('overflow')
        }
      }, [settingsOpen])

      React.useEffect(() => {
        if (workspaces.length === 0) return
        setWorkspaceChoice((current) => {
          if (current !== '' && workspaces.some((workspace) => pick(workspace, 'id') === current)) return current
          let stored = ''
          try {
            stored = window.localStorage.getItem(WORKSPACE_STORAGE_KEY) || ''
          } catch {
            stored = ''
          }
          if (stored !== '' && workspaces.some((workspace) => pick(workspace, 'id') === stored)) return stored
          const first = workspaces.find((workspace) => typeof pick(workspace, 'id') === 'string' && workspace.id !== '')
          return first ? String(pick(first, 'id')) : ''
        })
      }, [workspaces])

      const chooseWorkspace = (value) => {
        setWorkspaceChoice(value)
        setCreateError('')
        try {
          window.localStorage.setItem(WORKSPACE_STORAGE_KEY, value)
        } catch {
          /* private mode or a full quota must not break creation */
        }
      }

      const startCreation = async () => {
        if (creating || !ready) return
        const workspaceId = workspaceChoice !== '' && workspaces.some((workspace) => pick(workspace, 'id') === workspaceChoice) ? workspaceChoice : ''
        if (workspaceId === '') {
          setCreateError(t('create.noWorkspace'))
          return
        }
        setCreating(true)
        setCreateError('')
        try {
          await Promise.resolve(onCreateTask(workspaceId))
        } catch (reason) {
          setCreateError(messageOf(reason))
        } finally {
          setCreating(false)
        }
      }

      const selectId = 'dsh-oq-create-workspace'
      const workspaceOptions = workspaces.map((workspace) => {
        const id = String(pick(workspace, 'id') || '')
        const title = pick(workspace, 'title')
        const path = pick(workspace, 'path')
        const label = typeof title === 'string' && title ? title : typeof path === 'string' ? baseName(path) : id
        return { id, label, hint: typeof path === 'string' ? path : '' }
      })

      return h(
        'section',
        { className: 'dsh-oq-page', 'aria-label': t('title') },
        h(
          'div',
          { className: 'dsh-oq-scroll', ref: scrollRef },
          h(
            'div',
            { className: 'dsh-oq-content' },
            h(
              'header',
              { className: 'dsh-oq-head' },
              h('div', { className: 'dsh-oq-headMain' }, h('h1', { className: 'dsh-oq-h1' }, t('title'))),
              h(
                'div',
                { className: 'dsh-oq-headButtons' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-oq-btn dsh-oq-btn--outline',
                    'aria-haspopup': 'dialog',
                    'aria-expanded': settingsOpen ? 'true' : 'false',
                    'aria-controls': 'dsh-oq-settings',
                    onClick: () => settingsFlag.set(!settingsOpen),
                  },
                  t('action.settings'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dsh-oq-statusStrip' },
              billingChipsOf(data, t).map((chip) =>
                h(BillingChip, {
                  key: chip.id,
                  label: chip.label,
                  zone: chip.zone,
                  period: chip.period,
                  snapshot,
                  t,
                  onExpire: () => void store.refresh(),
                }),
              ),
            ),
            h(
              'div',
              { className: 'dsh-oq-createBar' },
              h(
                'div',
                { className: 'dsh-oq-createField' },
                h('label', { className: 'dsh-oq-createLabel', htmlFor: selectId }, t('create.workspace')),
                h(WorkspacePicker, {
                  id: selectId,
                  value: workspaceChoice,
                  options: workspaceOptions,
                  disabled: creating || workspaces.length === 0,
                  t,
                  onChange: chooseWorkspace,
                }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dsh-oq-btn dsh-oq-btn--primary dsh-oq-createButton',
                  disabled: creating || !ready || workspaces.length === 0,
                  onClick: () => void startCreation(),
                },
                creating ? t('create.starting') : t('create.submit'),
              ),
              createError ? h('span', { className: 'dsh-oq-createError', role: 'status' }, createError) : null,
            ),
            snapshot.error && ready ? h(Notice, { kind: 'warn' }, t('load.stale', { message: snapshot.error })) : null,
            ready ? h(ArmedList, { data, store, t, now, onOpenSession, sessionLabel }) : null,
            h(
              'div',
              { className: 'dsh-oq-tabs', role: 'tablist', 'aria-label': t('tabs.aria') },
              [
                { key: 'queue', label: t('tabs.queue'), count: countOf('queued') + countOf('running') + countOf('done') + countOf('failed') + countOf('cancelled') },
                { key: 'stats', label: t('tabs.stats'), count: null },
              ].map((tab) =>
                h(
                  'button',
                  {
                    key: tab.key,
                    type: 'button',
                    role: 'tab',
                    className: 'dsh-oq-tab',
                    'aria-selected': topTab === tab.key ? 'true' : 'false',
                    'data-active': topTab === tab.key ? 'true' : undefined,
                    onClick: () => setTopTab(tab.key),
                  },
                  h('span', null, tab.label),
                  tab.count === null ? null : h('span', { className: 'dsh-oq-tabCount' }, String(tab.count)),
                ),
              ),
            ),
            snapshot.phase === 'loading' && !data
              ? h(
                  'div',
                  { className: 'dsh-oq-loading', role: 'status' },
                  h('span', { className: 'dsh-oq-spinner', 'aria-hidden': 'true' }),
                  h('span', null, t('load.loading')),
                )
              : null,
            snapshot.phase === 'error' && !data
              ? h(
                  'div',
                  { className: 'dsh-oq-errorCard' },
                  h('p', { className: 'dsh-oq-errorTitle' }, t('load.errorTitle')),
                  h('p', { className: 'dsh-oq-errorDetail' }, snapshot.error),
                  h('button', { type: 'button', className: 'dsh-oq-btn dsh-oq-btn--outline', onClick: () => void store.refresh() }, t('load.errorRetry')),
                )
              : null,
            ready && topTab === 'queue'
              ? h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'dsh-oq-subtabs', role: 'tablist', 'aria-label': t('tabs.statusAria') },
                    statusTabs.map((tab) =>
                      h(
                        'button',
                        {
                          key: tab.key,
                          type: 'button',
                          role: 'tab',
                          className: 'dsh-oq-subtab',
                          'aria-selected': statusTab === tab.key ? 'true' : 'false',
                          'data-active': statusTab === tab.key ? 'true' : undefined,
                          onClick: () => setStatusTab(tab.key),
                        },
                        h('span', null, tab.label),
                        h('span', { className: 'dsh-oq-subtabCount' }, String(tab.count)),
                      ),
                    ),
                  ),
                  filtered.length === 0
                    ? h('p', { className: 'dsh-oq-listEmpty' }, t('list.empty'))
                    : h(
                        'ul',
                        { className: 'dsh-oq-rows' },
                        filtered.map((task) =>
                          h(TaskRow, {
                            key: pick(task, 'id'),
                            task,
                            data,
                            store,
                            t,
                            now,
                            onOpenSession,
                            onStatsRefresh: () => void statsStore.refresh(),
                          }),
                        ),
                      ),
                )
              : null,
            ready && topTab === 'stats' ? h(StatsSection, { statsStore, data, t }) : null,
            ready
              ? h(
                  'footer',
                  { className: 'dsh-oq-footer' },
                  h(
                    'span',
                    { className: 'dsh-oq-footerItem' },
                    t('footer.dataFile'),
                    typeof pick(pick(data, 'engine'), 'dataFile') === 'string'
                      ? h('span', { className: 'dsh-oq-footerCode' }, pick(data.engine, 'dataFile'))
                      : '—',
                  ),
                  h('span', { className: 'dsh-oq-footerItem' }, t('footer.rule')),
                )
              : null,
          ),
        ),
      )
    }

    // ────────────────────────────────────────────────────────────────────────
    // Sidebar session-row mark for sessions with an active off-peak task
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Small moon mark in a session row's leading cell while the session has a
     * queued or running off-peak task (idle rows show this slot instead of the
     * status dots).
     *
     * @param {{ sessionId: string, store: object, t: Function }} props - mark props.
     * @returns {import('react').ReactElement|null} mark.
     */
    function SessionOffpeakMark({ sessionId, store, t }) {
      const snapshot = useSnapshot(store)
      const tasks = listOf(pick(snapshot.data, 'tasks'))
      const count = tasks.filter((task) => pick(task, 'sourceSessionId') === sessionId && isActiveTask(task)).length
      if (count === 0) return null
      return h(
        'span',
        {
          className: 'dsh-oq-sessionMark',
          title: t('mark.active', { n: count }),
          role: 'img',
          'aria-label': t('mark.active', { n: count }),
        },
        h(OffpeakIcon, { size: 14 }),
      )
    }

    /**
     * The sidebar panellist entry glyph: the off-peak moon plus a small green
     * dot while a finished task has not been opened in the panel yet.
     *
     * @param {{ size?: number, store: object, seenStore: object, t: Function }} props - entry props.
     * @returns {import('react').ReactElement} entry glyph.
     */
    function OffpeakEntry({ size, store, seenStore, t }) {
      const snapshot = useSnapshot(store)
      const seenAt = useStore(seenStore)
      const unseen = hasUnseenFinished(snapshot.data, seenAt)
      return h(
        'span',
        { className: 'dsh-oq-entryGlyph' },
        h(OffpeakIcon, { size: typeof size === 'number' ? size : 18 }),
        unseen
          ? h('span', {
              className: 'dsh-oq-entryDot',
              title: t('mark.unseen'),
              role: 'img',
              'aria-label': t('mark.unseen'),
            })
          : null,
      )
    }

    // ────────────────────────────────────────────────────────────────────────
    // Plugin wiring
    // ────────────────────────────────────────────────────────────────────────

    /** Client plugin dependencies. */
    const inject = ['slots', 'locale', 'commandUi']

    /**
     * Register the composer command and chip, the management page, the toast
     * overlay, the sidebar entry and the session-row marks, and own their
     * effects.
     *
     * @param {object} ctx - Client plugin context.
     * @returns {void}
     */
    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      const store = createSnapshotStore()
      const statsStore = createStatsStore()
      const seenStore = createSeenStore()
      const toasts = createToastStore()
      const settingsFlag = createFlagStore(false)

      // The page, composer chip, toasts and sidebar marks are different React
      // trees; one plugin-owned stylesheet in <head> styles all of them.
      // Removing it on unload restores the page exactly.
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-offpeak-queue'
        tag.dataset.pluginCss = 'dsh-offpeak-queue/styles'
        tag.textContent = STYLES + STYLES_EXTRA
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, 'offpeak-queue: stylesheet')

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'offpeak-queue: dictionaries')
      ctx.effect(
        () => () => {
          store.dispose()
          statsStore.dispose()
          seenStore.dispose()
          toasts.dispose()
          settingsFlag.dispose()
        },
        'offpeak-queue: snapshot and toast stores',
      )

      /** Reveal a conversation in the main view (best effort; never crashes the page). */
      const openSession = (sessionId) => {
        try {
          const workspace =
            (typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined) ||
            (typeof ctx.uiWorkspace === 'object' ? ctx.uiWorkspace : undefined)
          if (workspace && typeof workspace.openSession === 'function') {
            workspace.openSession(sessionId)
            return
          }
          console.warn('[offpeak-queue] uiWorkspace service is unavailable; cannot open the session')
        } catch (error) {
          console.warn('[offpeak-queue] failed to open the session:', error)
        }
      }

      /** Best-effort title of one conversation from the client session list. */
      const sessionLabel = (sessionId) => {
        try {
          const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
          const entry = sessions?.list?.getSnapshot?.()?.byId?.[sessionId]
          if (entry && typeof entry === 'object') {
            const title = typeof entry.displayTitle === 'string' ? entry.displayTitle : typeof entry.title === 'string' ? entry.title : ''
            if (title !== '') return title
          }
        } catch (error) {
          console.warn('[offpeak-queue] failed to read the session title:', error)
        }
        return ''
      }

      /**
       * Per-conversation memory of the files pasted into an armed creation
       * draft. DSH keeps a draft as text only, so the composer's attachments
       * vanish when its Session shell unmounts; these File objects are the copy
       * that lets the keeper put them back.
       */
      const draftMemory = (() => {
        /** Maximum files per conversation kept in memory. */
        const MAX_FILES = 6
        /** sessionId -> { files: [{ id, file }], known: Set<string> } */
        const stash = new Map()

        /** The Session's conversation service, the same path DSH's own docks use. */
        const conversationOf = (sessionId) => {
          try {
            const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
            const scope = typeof sessions?.scope === 'function' ? sessions.scope(sessionId) : undefined
            const conversation = typeof scope?.get === 'function' ? scope.get('conversation') : undefined
            return conversation !== null && typeof conversation === 'object' ? conversation : undefined
          } catch (error) {
            console.warn('[offpeak-queue] the conversation service is unavailable:', error)
            return undefined
          }
        }

        return {
          /**
           * Remember the live files behind a set of composer attachment ids.
           *
           * @param {string} sessionId - conversation id.
           * @param {string[]} ids - current draft attachment ids.
           * @returns {void}
           */
          capture(sessionId, ids) {
            if (ids.length === 0) return
            const conversation = conversationOf(sessionId)
            if (!conversation || typeof conversation.resolveDraftAttachments !== 'function') return
            let entries = []
            try {
              entries = conversation.resolveDraftAttachments(ids)
            } catch (error) {
              console.warn('[offpeak-queue] failed to read the draft attachments:', error)
              return
            }
            const record = stash.get(sessionId) || { files: [], known: new Set() }
            for (const entry of listOf(entries)) {
              const id = pick(entry, 'id')
              const file = pick(entry, 'file')
              if (typeof id !== 'string' || record.known.has(id)) continue
              if (!(file instanceof Blob)) continue
              record.known.add(id)
              record.files.push({ id, file })
            }
            if (record.files.length > MAX_FILES) record.files = record.files.slice(-MAX_FILES)
            if (record.files.length > 0) stash.set(sessionId, record)
          },
          /**
           * Forget one conversation's kept files.
           *
           * @param {string} sessionId - conversation id.
           * @returns {void}
           */
          forget(sessionId) {
            stash.delete(sessionId)
          },
          /**
           * Re-attach the kept files to a freshly restored draft.
           *
           * @param {string} sessionId - conversation id.
           * @param {{ addAttachments?: Function }|undefined} inputActions - composer actions.
           * @returns {number} how many files were put back.
           */
          restore(sessionId, inputActions) {
            const record = stash.get(sessionId)
            if (record === undefined || record.files.length === 0) return 0
            if (!inputActions || typeof inputActions.addAttachments !== 'function') return 0
            const conversation = conversationOf(sessionId)
            if (!conversation || typeof conversation.createDrafts !== 'function') return 0
            let created = []
            try {
              created = conversation.createDrafts(
                sessionId,
                record.files.map((entry) => entry.file),
              )
            } catch (error) {
              console.warn('[offpeak-queue] failed to recreate the draft images:', error)
              return 0
            }
            const ids = listOf(created)
              .map((entry) => pick(entry, 'id'))
              .filter((id) => typeof id === 'string')
            if (ids.length === 0) return 0
            if (inputActions.addAttachments(ids) === false) return 0
            for (const id of ids) record.known.add(id)
            return ids.length
          },
        }
      })()

      /** Workspace id owning one conversation (the arm body requires it). */
      const workspaceIdOfSession = (sessionId) => {
        try {
          const workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
          const sessions = workspace?.sessions?.list?.getSnapshot?.()
          const cwd = typeof sessions?.byId?.[sessionId]?.cwd === 'string' ? sessions.byId[sessionId].cwd : ''
          const items = listOf(workspace?.workspaces?.list?.getSnapshot?.()?.items)
          const bySession = items.find((item) => Array.isArray(item?.sessionIds) && item.sessionIds.includes(sessionId))
          if (bySession && typeof bySession.workspaceId === 'string' && bySession.workspaceId !== '') return bySession.workspaceId
          const byPath = cwd === '' ? undefined : items.find((item) => item?.path === cwd)
          if (byPath && typeof byPath.workspaceId === 'string' && byPath.workspaceId !== '') return byPath.workspaceId
          const snapshotWorkspaces = listOf(pick(store.getSnapshot().data, 'workspaces'))
          const fallback = cwd === '' ? undefined : snapshotWorkspaces.find((item) => pick(item, 'path') === cwd)
          if (fallback && typeof pick(fallback, 'id') === 'string' && fallback.id !== '') return fallback.id
        } catch (error) {
          console.warn('[offpeak-queue] failed to resolve the conversation workspace:', error)
        }
        return ''
      }

      /**
       * Toggle the armed creation state of one conversation. Arming makes the
       * next submitted message the task (zero model calls); disarming returns
       * the conversation to normal chat.
       */
      const toggleArmed = async (sessionId) => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        try {
          let data = store.getSnapshot().data
          if (!data) {
            await store.refresh()
            data = store.getSnapshot().data
          }
          const armed = listOf(pick(data, 'armed')).some((entry) => pick(entry, 'sessionId') === sessionId)
          if (armed) {
            await store.mutate(disarmPath(sessionId), {})
            toasts.push('success', t('toast.disarmed'))
            return
          }
          const workspaceId = workspaceIdOfSession(sessionId)
          if (workspaceId === '') throw new Error(t('toast.noWorkspace'))
          await store.mutate(armPath(sessionId), { workspaceId })
          toasts.push('success', t('toast.armed'))
        } catch (error) {
          toasts.push('error', t('toast.failed', { message: messageOf(error) }))
        }
      }

      /**
       * Open a fresh conversation in one workspace and arm it for zero-call
       * creation, so the panel's create button lands in a ready composer.
       */
      const createTaskInWorkspace = async (workspaceId) => {
        const workspace = typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : undefined
        if (!workspace || typeof workspace.connectWorkspace !== 'function' || typeof workspace.openSession !== 'function') {
          throw new Error(t('create.unavailable'))
        }
        let sessionId
        try {
          sessionId = await workspace.connectWorkspace(workspaceId)
        } catch (error) {
          throw new Error(t('create.failed', { message: messageOf(error) }))
        }
        if (typeof sessionId !== 'string' || sessionId === '') throw new Error(t('create.unavailable'))
        await store.mutate(armPath(sessionId), { workspaceId })
        workspace.openSession(sessionId)
        toasts.push('success', t('toast.armed'))
        return sessionId
      }

      /**
       * Arm the conversation as an update target for one queued task: the task
       * text is then submitted from the composer like a normal message, the
       * conversation shows it, and the task keeps its identity/queue position.
       */
      const startEditTask = async (sessionId, task) => {
        const taskId = typeof pick(task, 'id') === 'string' ? task.id : ''
        if (taskId === '') throw new Error(t('toast.noWorkspace'))
        const stored = typeof pick(task, 'sourceWorkspaceId') === 'string' ? task.sourceWorkspaceId : ''
        const workspaceId = workspaceIdOfSession(sessionId) || stored
        if (workspaceId === '') throw new Error(t('toast.noWorkspace'))
        await store.mutate(armPath(sessionId), { workspaceId, taskId })
        toasts.push('success', t('toast.editing'))
      }

      // The composer command: an action contribution consumed on Enter (or a
      // menu pick) that arms the current conversation without submitting.
      const commandUi = typeof ctx.get === 'function' ? ctx.get('commandUi') : ctx.commandUi
      if (commandUi && typeof commandUi.register === 'function') {
        ctx.effect(
          () =>
            commandUi.register({
              name: COMMAND_NAME,
              label: () => t('command.label'),
              description: () => t('command.description'),
              available: () => true,
              ui: {
                kind: 'action',
                run: (session) => {
                  const sessionId = typeof pick(session, 'sessionId') === 'string' ? session.sessionId : ''
                  void toggleArmed(sessionId)
                },
              },
            }),
          'offpeak-queue: composer command',
        )
      } else {
        console.warn('[offpeak-queue] command service is unavailable; the off-peak command was not registered')
      }

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => ({ store, statsStore, seenStore, settingsFlag, t, onOpenSession: openSession, sessionLabel, onCreateTask: createTaskInWorkspace }),
          },
          OffpeakPage,
        ),
      )

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 60,
            locale: NS,
            label: () => t('panel'),
            inject: () => ({ store, seenStore, t }),
          },
          OffpeakEntry,
        ),
      )

      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'offpeak-armed',
            order: 20,
            locale: NS,
            inject: (sessionId) => ({ sessionId: String(sessionId), store, toasts, t }),
          },
          ComposerArmedChip,
        ),
      )

      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'offpeak-task',
            order: 20,
            locale: NS,
            inject: (sessionId) => ({
              sessionId: String(sessionId),
              store,
              t,
              toasts,
              onEditTask: (task) => startEditTask(String(sessionId), task),
            }),
          },
          BoundTaskBar,
        ),
      )

      // Renders nothing: it only keeps and restores the images of an armed
      // creation draft, which the composer loses when its Session unmounts.
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.dock',
            id: 'offpeak-draft',
            order: 21,
            locale: NS,
            inject: (sessionId) => ({ sessionId: String(sessionId), store, toasts, t, draftMemory }),
          },
          OffpeakDraftKeeper,
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'offpeak-toasts',
            order: 70,
            locale: NS,
            inject: () => ({ store: toasts }),
          },
          OffpeakToasts,
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'offpeak-task-watcher',
            order: 71,
            locale: NS,
            inject: () => ({ store, toasts, t }),
          },
          OffpeakTaskWatcher,
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'offpeak-settings-modal',
            order: 72,
            locale: NS,
            inject: () => ({ flag: settingsFlag, store, t }),
          },
          SettingsModalHost,
        ),
      )

      ctx.slots.inject('sidebar.session.row.leading', () =>
        ctx.slots.register(
          {
            name: 'sidebar.session.row.leading',
            id: 'offpeak-mark',
            order: 20,
            locale: NS,
            inject: () => ({ store }),
          },
          SessionOffpeakMark,
        ),
      )
    }

    return { inject, apply }
  },
})
