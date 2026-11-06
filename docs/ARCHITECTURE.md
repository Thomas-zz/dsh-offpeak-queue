# Architecture & behaviour contract — dsh-offpeak-queue v2

This is the source of truth for how the Host half (queue engine, scheduler, HTTP API,
agent tool) and the Client half (composer chip, task bar, panel, stats) behave.
It describes the v2 conversation-first design; earlier v1 notes were internal and are
not published.

> **Multi-family update (v7, 2026-11-06):** the queue now schedules per **model
> family** — DeepSeek (calendar from the persisted settings) and GLM (built-in
> Coding Plan rule, `host/families.js`). `agent/pre-step` classifies the
> conversation's resolved route from `payload.modelSelection` and stores the
> family on the task; the scheduler checks each candidate against **its own
> family's calendar**, and each run step is tiered by the family of the model
> that actually served it. GLM runs are estimated in Coding-Plan credits
> (`pricing.js`: official coefficients × measured tokens; no network — GLM has
> no public API-key usage endpoint, ZCode's balance APIs are behind its own
> OAuth backend). Settings add `familyEnabled` per family; a disabled family is
> never intercepted (the arm survives with a dock hint), shows no chip, and
> `add` rejects it with 409. Data format v5 adds `task.modelFamily`,
> step/run `points`/`pointsSaved`, lifetime `familyRuns`/`glmPoints`/
> `glmPointsSaved`; v4 files migrate with defaults. `/snapshot` adds
> `families` (id/label/enabled) and `periods` (enabled families only; the
> legacy `period` stays as the DeepSeek view). The panel header renders one
> billing chip per enabled family, settings gain per-family switches, queue
> rows/task bars carry family tags, and the stats page splits cards, the
> by-model table (credits + token columns), the chart's run-count series and
> recent runs per family.

> **UI update (v3, 2026-11-04):** the creation entry is now the composer command
> `/闲时任务` plus a compact chip in the composer toolbar (`conversation.input.left`).
> The panel's workspace select and 「新建闲时任务」 button, the conversation dock card
> (`conversation.input.dock`), the completion banner and the pre-filled task template
> are removed. The panellist entry shows a green dot while a finished task has not been
> seen in the panel; queue rows are minimal and open the source conversation for detail.
> Host behaviour below (arm/disarm, `agent/pre-step` interception, execution, pricing,
> statistics) is unchanged; §2 and the dock/client bullets in §1 are historical.

> **UI update (v4, 2026-11-04):** the panel gets the workspace select +
> 「新建闲时任务」 button back: it opens a fresh conversation in that workspace and
> arms it (zero-call creation) in one click. The conversation dock returns as a
> single-line task bar (created / running / cancelled / failed) with inline
> edit / cancel / retry / delete, so a panel-side cancel is visible in the
> conversation. Settings shrink to auto-run + max concurrency (default 3);
> timeout, peak windows, holidays and prices are internal defaults, not user
> configuration. Host wake for execution now appends a plugin-trigger
> `user/message` (`source.kind = 'cordis-host-runner'`) through the agent inbox
> instead of `sessionController.prompt`, so the conversation renders a
> 「插件状态更新」 trigger card rather than a human bubble. Data format v3 adds
> the old-default concurrency migration (1 → 3).

> **Log-safety update (0.2.1, 2026-11-05):** `agent/pre-step` interception must
> **never write to the session log**. The session format requires the first
> model-visible event of a log to be a protected `system/message`, and only the
> Agent loop writes one (inside `step()`), so a plugin `session.append`
> of the claimed message before any step leaves a log that fails to load on the
> next launch (`SessionFormatError: system/message requires a protected first
> surface head`). Creation and edit turns therefore only reject the step; the
> claimed content blocks (`text`/`image`/`file`) are stored on the task record
> (`task.content`) and replayed by the runner inside the execution wake message,
> whose text is `EXECUTION_MESSAGE[trigger] + "\n\n" + task.prompt`. Start-up
> additionally heals logs an earlier release damaged (`host/repair.js`): the
> stray leading `user/message` moves behind the first protected `system/message`,
> sequences and event references are renumbered, the original file is kept as
> `*.bak-<stamp>`, and live sessions are skipped. The dock bar's width is the
> chat content column (`max-width: var(--dsh-chat-content-width)`, centered) —
> the same box the in-conversation 「插件状态更新」 card occupies.

> **UI update (v5, 2026-11-04):** the panel is split into two top-level tabs
> (`任务队列` / `统计`) with four status subtabs under the queue (`等待 / 执行中 /
> 已完成 / 失败`, cancelled rows appear under 失败) and count badges; the giant
> count strip is gone. Statistics drop the paid/actual-cost series and columns —
> only savings remain. Settings keep max concurrency only: the auto-run switch is
> removed and execution is always automatic, so data format v4 forces
> `autoRun = true` on migration. Task editing returns to the composer: the task
> bar's 修改 button arms the conversation as an **update target**
> (`POST /sessions/:id/arm {workspaceId, taskId}` → arm record
> `{mode:'update', taskId}`), the task text is loaded into the draft, the user
> rewrites it (attachments included) like a normal message, and `agent/pre-step`
> updates the same queued task (same id/order, refreshed guidance) with zero
> model calls. While an update arm exists the scheduler skips that task, so the
> edit always lands before execution. The submitted message is persisted, so the
> edited content is visible in the conversation and is what the model sees when
> the task runs.

> **UI update (v6, 2026-11-04):** UI polish pass driven by user screenshots.
> Queue subtabs become six (`全部 / 等待 / 执行中 / 已完成 / 失败 / 已取消`), with
> failed and cancelled separated. The workspace control becomes a searchable
> combobox (filter box, ↑/↓/Enter/Esc, click-outside close) instead of a native
> `<select>`. The conversation dock card is now a single-line collapsible card
> (glyph + status + title + timing + chevron); actions live in the expanded
> body, and cancelled/failed cards start expanded. Statistics: the savings
> cards auto-fit the available width, the 「创建开销 ¥0 · 零调用创建 N 次」
> strip is removed (creation is free by design, no separate line), and the
> 「最近执行」 list is a fixed-column grid (任务 / 状态 / 方式 / 时间 / 节省) so the
> right-hand numbers align row by row. Plugin toasts centre with a full-width
> flex layer (no `left:50% + translateX`) so they stay centred inside any
> transformed overlay container.

## 0. Product decision (from the user)

- 创建不再是表单，也**不替换输入框**：点面板里的「新建闲时任务」= 在所选的当前工作区里**正常新建一个会话**
  （等同于点「新会话」），只是这个会话被插件接管为「闲时任务创建会话」：
  - 输入框里**预填一段可编辑的默认提示词模板**（通过 dock 卡片调 `inputActions.setDraft(template)`，
    绝不替换 composer 组件）；
  - 输入框上方出现插件卡片：`闲时任务 · 回车只入队，不调用模型`（含 chip 样式，用户能看出是插件）；
  - 用户正常编辑任务描述、回车提交 → **不调用任何模型**：Host 在 `agent/pre-step` 拦截并拒绝该步，
    只把这条 user 消息记录为任务，返回创建成功提示（dock 卡片 + notify）；
  - 该会话因此产生 `turn/start` → 不再是 blank session，会出现在该工作区的会话列表里，标题改为
    `<标题>`（任务标题本身，不加前缀；侧栏用月亮图标标记闲时会话）；不点开插件也能在工作区看到这个对话；
  - 这个会话就是**来源对话**，到点后**在同一个对话里**执行任务（不再另起执行会话）。
- 执行方式：
  1. 到闲时自动执行：Host 向来源会话 `sessionController.prompt` 一条开始指令，模型在该对话里干活；
  2. 用户在来源对话里说「执行这个任务」：模型调用 `offpeak_queue` 的 `run_current`（无 id 也可），
     插件立即在该对话执行（不受峰谷限制、无二次确认）；
  3. 来源对话卡片/面板任务行上的「立即执行」小按钮：直接触发（无二次弹窗）。
- 高峰：插件不干预普通对话；排队任务默认只在闲时自动启动；手动执行任何时段都可以、不弹窗；
  执行中跨入高峰**继续跑完**，费用按每步实际完成时刻的峰谷价计算。
- 统计：放在「闲时任务」面板内的「统计」区块；按真实 token 用量与官方价目表估算；创建阶段 0 调用、
  创建开销恒为 ¥0（v6 起面板不再单列这一行，创建零调用由 Host 行为保证）。

## 1. What v2 keeps from v1

- Host/Client bundle structure, sidebar panellist entry `闲时任务` + `main` page id `offpeak`,
  HTTP prefix route `/dsh-offpeak`, loopback Host/Origin trust fence, bounded JSON bodies.
- Off-peak calendar policy (`host/policy.js`: peak windows, weekends, 2026 holidays, IANA zone,
  `resolvePeriod`, `nextOffpeakStart`) — unchanged.
- Persisted queue at `$DSH_HOME/offpeak-queue.json` (`DSH_OFFPEAK_DATA_FILE` override), atomic writes,
  finished-history cap 100, restart reconciliation for running runs, settings validation.
- `offpeak_queue` tool (actions extended, see §6), settings (autoRun, maxConcurrent, taskTimeoutMinutes,
  timeZone, peakWindows, holidays, permissionPreset).
- Client: locale namespace `offpeakQueue`, 4 s snapshot polling while mounted, only `--dsw-alias-*`
  tokens, no Harness client imports beyond `react`, light/dark, zh/en.

## 2. Creation flow (exact sequence)

Client side:

1. Panel header gains a workspace `<select>` (from `snapshot.workspaces`) + primary button
   `新建闲时任务`. Default selection = first workspace (or persisted last choice in localStorage).
2. Click → set module-level `pendingCreation = { workspaceId, at }` → call
   `ctx.uiWorkspace.startSession(workspaceId)` (opens/reuses the workspace's blank New Session,
   exactly the normal "new conversation" behaviour; do not touch composer here).
3. Client registers `conversation.input.dock` (session scope). For the current session:
   - If `pendingCreation` is set and the session is blank (snapshot/task data shows no bound task and
     session has no user message), **first read the current draft through `useInput` / `input` owner prop**:
     - draft text is empty → consume the flag: `POST /dsh-offpeak/sessions/:sessionId/arm`
       `{workspaceId}`, then `inputActions.setDraft(DEFAULT_TEMPLATE)`, clear `pendingCreation`, and render
       the creation card:
     chip `闲时任务`, text 「直接输入任务描述，回车只入队，不调用模型；到闲时自动在这个对话里执行」,
       button 「取消创建」(POST disarm; `inputActions.setDraft('')` if draft still equals template).
     - draft text is NOT empty (the user already typed something in this blank session) → do NOT arm and do
       NOT overwrite the draft; clear `pendingCreation` and show a transient notice
       「当前新会话已有草稿，请先清空输入或再点一次新建闲时任务」. (Clicking 新建 again after clearing
       the draft creates/arms a fresh target.)
   - Else if the session has a task bound (`task.sourceSessionId === sessionId`) render the task card:
     status chip (等待闲时 / 执行中 / 已完成 / 失败 / 已取消), title, expected time or elapsed,
     savings estimate (`约省 ¥x`), buttons 「立即执行」(queued) / 「取消」/ 「重试」/ 「打开面板」.
   - Poll `GET /snapshot` (shared store, 4 s) — while `armed`/running the dock may refresh faster (1 s).
4. Success feedback: when the shared store refresh finds the task created for the armed session (the
   arm is gone and a task with `sourceSessionId === sessionId` exists), render the success card
   `已创建闲时任务「<title>」· 预计 <time> 执行` and, optionally, an app-level toast rendered by this
   plugin in `shell.overlay` (there is **no** `inputActions.notify`; the dock `InputActions` face is
   `captureInsertion/insertText/setDraft/persistDraft/addAttachments/removeAttachment/pruneAttachments/
   submit`, and the draft text is readable from `input.draft` / `useInput(s => s.draft)`). While armed or
   running, poll the snapshot faster (≈1 s) so the success card appears promptly; otherwise 4 s.
   Also available if the user reloads.
5. `DEFAULT_TEMPLATE` (zh; independent en template):
   ```
   请描述要在闲时执行的任务：
   任务目标：
   验收标准 / 输出要求：
   相关文件或目录：
   ```
   Host validates the claimed text on interception: trimmed non-empty, and not equal to the template
   (a message containing only labels/whitespace must not create a task; keep the session armed and
   record `armed.lastError = '任务描述不能为空'` so the dock shows the error — next message retries).
6. Clicking 新建 while a previous creation session is still armed: the previous arm stays (panel shows
   it in a small 「待创建对话」 list with open/cancel actions) — do not lose it silently.

Host side:

7. `POST /sessions/:id/arm` → validates the session is live or resumable and not archived, records
   `armed[sessionId] = { workspaceId, armedAt, status:'armed', lastError? }`, persists, returns
   `{ok, armed}`. Max 20 armed sessions; stale arms (>12 h) are pruned on load/tick.
8. On every `agent/pre-step` (global waterfall listener, `ctx.on('agent/pre-step', ...)`):
   - If the agent's session id is NOT armed → `return next()`.
   - Extract text blocks from `payload.messages` (the claimed inbox user messages; runtime context is
     only added by `next()`, never in this payload). Join with `\n\n`, trim.
   - Validate per §2.5. On invalid: keep armed, set `lastError`, persist, and `return { kind: 'reject' }`.
   - On valid: create the task bound to `sessionId` (prompt = text, title = first non-empty line
     trimmed to ≤120, cwd = `session.header.cwd`, status `queued`, sourceSessionId, sourceWorkspaceId),
     disarm the session (delete armed record, clear lastError), persist, and **return
     `{ kind: 'reject' }`** — the agent loop then ends the turn as `blocked` with **no model request**
     (`turn/start` was already appended, so the session is non-blank and visible in the sidebar).
   - Best-effort after creating: `ctx.get('sessionTitle')?.rename(session, title)`（任务标题本身，
     不加 `闲时任务 · ` 之类前缀）；register the session-scoped model guidance (§5) on `agent.ctx`;
     notify nothing else.
   - Failures inside the listener must `return next()` (never break the user's turn) and record
     `lastError`/log.
   - The handler must be idempotent for the same session: after creating one task, disarm so later
     messages are normal model turns.
9. `POST /sessions/:id/disarm` → drop the arm (idempotent); `GET /snapshot` exposes
   `armed: [{sessionId, workspaceId, armedAt, lastError?}]`.

Important: the blocked creation turn must be acceptable UI-wise. Verify in the browser that the
transcript shows the user's task message and no broken/odd error row (a `turn/end` reason `kind:'blocked'`
is intentionally not rendered as a turn error by the shipped chat renderer — confirm).

## 3. Execution (in the source conversation)

- A task is due when `status==='queued'` and (`forceRun` OR current period is offpeak), same scheduler
  rules, `maxConcurrent` counts in-flight task runs.
- Start a run:
  1. Mark task `running` (`startedAt`, `attempts+`, `runTrigger='offpeak'|'manual'`, `baselineSeq`).
  2. `await ctx.sessionController.prompt({ requestId, sessionId: task.sourceSessionId, mode:'queue',
     content:[{type:'text', text: EXECUTION_MESSAGE}], clientTimeZone: settings.timeZone }, signal)`
     where `EXECUTION_MESSAGE` = `闲时任务到期，开始执行上面的任务。` for the automatic trigger and
     `现在开始执行上面的任务。` for manual/自然语言 triggers. **Never resend the task instruction**
     (it is already the unanswered user message in the session); the model sees it as history.
  3. After admission, locate the execution user message via its `rpcId` (requestId) among new session
     events; its seq = `userSeq`. The execution turn is the next `turn/start` with seq > userSeq; collect
     `assistant/message` events of that turn (seq > userSeq, before its `turn/end`) as **steps**
     (usage + `event.time`), and settle at that `turn/end` (or timeout / cancel).
  4. On settle: compute costs (§4), write the run ledger entry + task summary fields
     (`sessionId === sourceSessionId`, `turnEndKind`, `error`, `resultSnippet`, `usage` totals,
     `cost`, `saved`, `peakExtra`, `steps`), statuses: `completed→done`; `error/max-tokens/blocked→failed`;
     `aborted`→`cancelled` unless the user cancel action asked for it; timeout→`failed` + cancel turn;
     `interrupted`→`failed`. Keep the conversation itself (never archive/delete it).
  5. If the source session is archived/deleted/unavailable → fail the task with a readable Chinese
     reason (`来源对话已归档/不可用`), do not retry automatically.
- Manual triggers: `POST /tasks/:id/start` (any time, no confirmation), and the tool's `run_now`
  (fresh trigger even if `queued`). `POST /tasks/:id/start` on an already running task = 409.
- Natural-language path: the model sees the tool `offpeak_queue` (see §6). A new action
  `run_current` with no id executes the queued task bound to the calling session; when the tool is
  invoked from inside a turn on that same session, it must enqueue the execution prompt (mode `queue`)
  so it runs right after the current turn and return 「已开始执行，将在本条回复结束后继续」. From a
  different session it starts the run directly.
- Cancel while running: `POST /tasks/:id/cancel` → `sessionController.cancel({sessionId})`, settle as
  `cancelled` (turn/end `aborted` normally follows; keep the grace timeout from v1).
- Restart: on load, `running` tasks reconcile to `failed` with v1's restart message; keep `sessionId`.
- Execution never creates sessions. Remove the v1 "create a fresh session" path.

## 4. Cost model & statistics (must be accurate to tokens × prices)

Built-in price table (CNY per **million tokens**, peak price; off-peak = 50%). Settings `prices`
may override/add entries; unknown provider/model → no price (tokens recorded, cost null, `unpriced:true`).

```jsonc
{
  "deepseek-flash":     { "cacheHit": 0.04, "cacheMiss": 2,   "output": 8   },
  "deepseek-v4-pro":    { "cacheHit": 0.3,  "cacheMiss": 9,   "output": 27  },
  "deepseek-reasoner":  { "cacheHit": 0.04, "cacheMiss": 2,   "output": 8   } // alias if seen
}
```
Only providers `deepseek-account` and `deepseek-official` (and the v1 `deepseek` spelling, if present)
are priced; everything else is unpriced. Prices are configurable in settings (`prices` object) with a
`pricesVerifiedAt` string shown in the UI footnote.

Per step (`assistant/message` event with `usage`):

```
tier = resolvePeriod(event.time).kind            // billing tier = completion moment
inMiss = usage.inputTokens + (usage.cacheWriteTokens ?? 0)
inHit  = usage.cacheReadTokens ?? 0
out    = usage.outputTokens
costPeak   = (inMiss*cacheMiss + inHit*cacheHit + out*output) / 1e6
costOfStep = tier==='peak' ? costPeak : costPeak * 0.5
peakExtra  = costOfStep - costPeak*0.5           // what peak-crossing cost extra (0 for offpeak steps)
saved      = tier==='peak' ? 0 : costPeak*0.5     // offpeak steps save the half
```
Model/provider for pricing comes from the `assistant/message.source` (actual provider/model), not the
task config. Run totals: `cost.actual = Σ costOfStep`, `cost.peak = Σ costPeak`,
`cost.saved = Σ saved`, `cost.peakExtra = Σ peakExtra`, `steps: [{at, tier, usage, cost, saved, peakExtra,
provider, model}]` (cap 200 steps, keep last 200). A run that never produces an assistant message has
cost 0 and `steps: []`.

Run ledger (append-only, independent of task list): one record per run with
`{id, taskId, sessionId, title, model, provider, trigger:'offpeak'|'manual', startedAt, finishedAt,
status, steps, usage totals, cost, saved, peakExtra, unpriced}`. Cap 5000 newest + maintain lifetime
aggregates (`lifetime: {runs, saved, cost, peakCost, peakExtra, tokensIn, tokensOut,
zeroCallCreations}`) so stats survive ledger pruning. Deleting a task does **not** delete its runs.
`zeroCallCreations` increments on every pre-step-intercepted task creation (creation cost is 0).

`GET /stats?days=14` (default 14, clamp 1–365; time zone = settings.timeZone):
```jsonc
{ "ok": true, "now": 0, "days": 14,
  "lifetime": { "runs": 12, "saved": 0.42, "cost": 0.42, "peakCost": 0.84, "peakExtra": 0.0,
                "tokensIn": 12345, "tokensOut": 678, "zeroCallCreations": 3, "unpricedRuns": 0 },
  "range": { "runs": 5, "saved": 0.2, "cost": 0.2, "peakCost": 0.4, "peakExtra": 0.0, "unpricedRuns": 0 },
  "byDay": [{ "date": "2026-11-03", "runs": 2, "cost": 0.1, "peakCost": 0.2, "saved": 0.1, "peakExtra": 0 }],
  "byModel": [{ "model": "deepseek-flash", "provider": "deepseek-account", "runs": 3, "cost": 0.3,
                "saved": 0.3, "unpriced": false }],
  "recentRuns": [ /* newest 20 ledger entries, steps omitted or trimmed */ ],
  "pricesVerifiedAt": "2026-10-10" }
```
`/snapshot` additionally carries `stats` = the lifetime block + range for 7 days (cheap summary) and
`armed`. Panel statistics UI reads `/stats`.

UI wording must make clear these are estimates from official prices × measured tokens, not billed
amounts; creation cost is ¥0 because creation never calls a model.

## 5. Model-facing context and tool

- When a task is created, register on the agent scope (`agent.ctx`) one system-prompt section (dispose
  when the task settles/cancels or the plugin unloads) with roughly:
  `本会话关联一个待执行的闲时任务「<title>」（任务 id <id>，状态 等待闲时执行）。任务内容就是本会话最后一条用户消息。
   只有当用户明确要求“执行这个任务”时，调用 offpeak_queue 的 run_current；不要自行开始执行该任务内容。
   任务到闲时由宿主自动执行。`
- Tool `offpeak_queue` keeps v1 actions `add|list|update|cancel|retry|run_now|delete` plus:
  - `run_current` (no id): execute the queued task bound to the calling session (see §3).
  - `list` marks tasks bound to the calling session (`本会话`) so the model can find them.
  - `run_now` keeps executing a named task now (any trigger).
  - `add` binds `sourceSessionId` = calling session (so it appears as that session's task; no creation
    turn interception involved). Its text must not claim a queue position when the task already started.
  - Chinese descriptions; no model-visible changes elsewhere.

## 6. HTTP API v2 (prefix `/dsh-offpeak`, loopback fence as v1)

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/snapshot` | – | full snapshot: `now, period, settings, counts, tasks, workspaces, models, defaultModel, defaultCwd, engine, armed, stats` |
| POST | `/sessions/:id/arm` | `{workspaceId}` | `{ok, armed:{sessionId,workspaceId,armedAt,lastError?}}` |
| POST | `/sessions/:id/disarm` | `{}` | `{ok, disarmed:true}` |
| POST | `/tasks/:id/start` | `{}` | `{ok, task}` (manual immediate; 409 if running/not queued) |
| POST | `/tasks/:id/cancel` | `{}` | `{ok, task}` |
| POST | `/tasks/:id/retry` | `{}` | `{ok, task}` |
| POST | `/tasks/:id/delete` | `{}` | `{ok, deleted:true}` (never while running) |
| POST | `/tasks/:id/update` | `{title?, prompt?}` | `{ok, task}` (queued only) |
| POST | `/tasks/:id/move` | `{direction:'up'|'down'}` | `{ok, taskIds}` |
| POST | `/settings` | partial settings | `{ok, settings}` |
| GET | `/stats` | `?days=` | stats per §4 |
| POST | `/tick` | `{}` | `{ok, snapshot}` (debug) |

Remove from v1: `POST /tasks` (form creation), `/tasks/:id/run-now` (replaced by `start`), the old
session-runner endpoints. Old data files (`version:1`) migrate on load: tasks without
`sourceSessionId` are dropped with a logged warning (v1 queue is empty in practice); write
`version:2`, keep settings, start a fresh `runs/lifetime` store.

Task shape v2 (persisted, every field present):
```jsonc
{ "id":"t-…","order":0,"title":"…","prompt":"…","status":"queued",
  "sourceSessionId":"session-…","sourceWorkspaceId":"ws-…","cwd":"/abs",
  "createdAt":0,"updatedAt":0,"startedAt":null,"finishedAt":null,
  "attempts":0,"forceRun":false,"runTrigger":null,"turnEndKind":null,"error":null,
  "resultSnippet":null,"usage":null,"cost":null,"saved":null,"peakExtra":null,
  "steps":[],"baseline":null }
```
Snapshot task additions: `nextRunAt`, `sourceSessionTitle` (best effort), `isThisSession` is a client
concern only.

## 7. Client requirements

- Keep the two slots (`main` `offpeak`, `sidebar.panellist` `offpeak`) and locale dictionaries (zh is the
  key-set source; extend both, key sets/placeholders identical).
- No composer replacement. The only conversation integration is the `conversation.input.dock` card
  (plus optionally `sidebar.session.row.leading`/`.hover` markers for sessions with an active task,
  mirroring the shipped schedule clock mark; not required if it costs too much).
- The creation prefill uses `inputActions.setDraft(template)` from the dock props and only when the
  draft is empty; never overwrite user-typed text; the template is editable plain text.
- Panel: workspace select + 新建闲时任务; 「待创建对话」 list (armed sessions with open/disarm);
  queue list with status, title, expected/elapsed/finished time, source conversation title,
  立即执行 (no dialog), cancel/retry/delete/update/move; per-task savings (`约省 ¥x` / `未计价`);
  统计区块 (cards + 14-day chart drawn with inline SVG + byModel table + recent runs + disclaimer
  「按官方价目表与实测 token 估算，非账单金额」);
  settings section (add `prices` editing optional; keep existing settings) ;
  footer data-file + rule note.
- All existing v1 UI polish rules still hold (tokens only, no literal colors, aria, focus rings,
  responsive 520px+, zh/en, 4 s polling reset on unmount, isolated countdown).
- Panel opens conversations with `ctx.uiWorkspace.openSession(sessionId)`; creation uses
  `ctx.uiWorkspace.startSession(workspaceId)`.

## 8. Verification acceptance (verifier)

1. **Zero-call creation**: in a dev instance, arm + submit a task in a new conversation; inspect the
   session log: `user/message` + `turn/start` + `turn/end` reason `blocked`, and **no**
   `request/header`, **no** `assistant/message`; task queued with `sourceSessionId`; session
   `blank=false` (appears in workspace session list) and title equal to the task title with no
   prefix; UI shows success.
2. **Visible in workspace**: the creation conversation shows in the workspace session list (not only in
   the plugin panel) and can be opened after navigating away/reload.
3. **Auto execution in the same conversation** off-peak: prompt appears as a new user message in that
   conversation, model runs, task done with steps/usage/cost/saved > 0, sessionId === sourceSessionId.
4. **Manual execution**: start button and `run_current` path; manual at simulated peak → cost at peak,
   saved 0, `peakExtra`/peak bucket recorded.
5. **Cross-peak accounting**: simulate a peak window starting shortly after a run starts; verify the
   run's steps split across tiers and `cost.actual`, `cost.peak`, `saved`, `peakExtra` match the formula.
6. **API conformance** §6, trust fence, validation, 404/409, migration, restart reconciliation,
   stale arm pruning.
7. **Browser E2E**: panel new-task button opens a new conversation in the selected workspace with the
   template prefilled; typing + Enter creates the task with zero model call (dock card + success;
   no assistant reply); workspace list shows the conversation; dock card status/actions; panel stats;
   zh/en, light/dark, 520px, no console errors/slot crashes.
8. `node --test` green, `node --check` clean, no new npm deps.

## 9. Dev environment (recreate throwaway profiles; old ones were cleaned up)

```bash
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
"$DSH" <profile> --from-default-profile web --dump-config >/dev/null
"$DSH" plugin --profile <profile> add <repo-dir>
cat >> ~/.dsh/profiles/<profile>/cordis.patch.yml <<'EOF'
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: max
EOF
"$DSH" --profile <profile> --no-open --port 0   # background job; read the printed URL/token
```
Host JS changes require restarting the dev instance; Client `client.js` changes are picked up after a
page reload (a restart is the reliable path). Use a throwaway profile — never develop against the
profile you actually use.

## 10. Repository layout

- `index.js`, `host/`, `test/` — Host half: store, scheduler, runner, pre-step interception,
  HTTP API, agent tool, session-log repair.
- `client.js` — Client half: a single browser bundle rendered inside DSH.
- `package.json`, `cordis.patch.yml`, `locale/`, `icon.svg` — plugin packaging and display metadata.

## 11. Known constraints & pitfalls

- The blocked creation turn's transcript rendering (must not show a scary error row); if it does, report
  and we reconsider showing the success text differently.
- `agent/pre-step` payload contains only claimed inbox messages; verify runtime-context is not captured.
- `inputActions.setDraft` availability/timing on the dock; if the dock mounts before the session's input
  owner is ready, retry on the next tick once.
- Session list blank→visible transition depends on `turn/start`; confirm on the dev instance.
- Concurrent execution in several conversations must respect `maxConcurrent`; stats attribution uses
  per-run baseline seq so overlapping runs in different sessions stay separate.
- Live app restart is required to activate v2; the current session log survives it.
