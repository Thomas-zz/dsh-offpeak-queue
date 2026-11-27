/**
 * Client-bundle checks that need no browser.
 *
 * The client half is one hand-written script handed to `window.__ModuleLoader__`.
 * These tests run that script against a fake loader, the slice of React the
 * task bar and the queue page use, and the real dictionaries, then assert what
 * is easy to break by hand:
 *
 * - both dictionaries carry the same keys and placeholders, and every `t()` key
 *   the script asks for exists;
 * - a conversation that holds several tasks lists them in submission order and
 *   keeps that order whatever happens to a row, so working down the list
 *   cancelling one task after another never moves the rest;
 * - the panel's 「全部」 tab orders tasks by creation time, newest first.
 *
 * @module @zayn_/dsh-offpeak-queue/test/client
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

/** 2026-11-27 11:00 in Asia/Shanghai: the pinned clock every timing phrase is written against. */
const NOW = Date.UTC(2026, 10, 27, 3, 0, 0)

/**
 * The slice of React the client's task bar and queue page use: `createElement`,
 * `Fragment`, the common hooks, and a renderer that re-runs function components
 * until their state settles. Host elements stay plain objects, so a test reads
 * the tree a component produced. Instances live per root identity, so state
 * survives between renders exactly as it does under React.
 *
 * @returns {{ React: object, render: Function }} fake React and its renderer.
 */
function createFakeReact() {
  const Fragment = Symbol('Fragment')
  const createElement = (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } })
  /** One component or host element: its hook slots and the instances below it. */
  const createInstance = () => ({ hooks: [], cursor: 0, children: new Map(), pending: [] })
  let current = null
  let dirty = false
  let queued = []
  let idCounter = 0
  const slot = () => {
    const index = current.cursor
    current.cursor += 1
    return index
  }
  const remember = (initial) => {
    const index = slot()
    if (!(index in current.hooks)) current.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    return current.hooks[index]
  }
  const changed = (prev, deps) => !prev || !deps || deps.some((value, index) => !Object.is(value, prev.deps[index]))
  const effect = (apply, deps) => {
    const index = slot()
    const prev = current.hooks[index]
    if (!changed(prev, deps)) return
    const entry = { deps, cleanup: prev?.cleanup }
    current.hooks[index] = entry
    current.pending.push(() => {
      entry.cleanup?.()
      entry.cleanup = apply()
    })
  }
  const child = (parent, key) => {
    let instance = parent.children.get(key)
    if (!instance) {
      instance = createInstance()
      parent.children.set(key, instance)
    }
    return instance
  }
  /** A keyed element keeps its instance wherever it sits in the list, as in React. */
  const nodeKey = (node, positional) =>
    node && typeof node === 'object' && !Array.isArray(node) && node.props.key !== undefined ? `k:${String(node.props.key)}` : positional
  const renderNode = (node, parent, key, out) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) {
      node.forEach((entry, index) => renderNode(entry, parent, nodeKey(entry, `${key}[${index}]`), out))
      return
    }
    if (typeof node !== 'object') {
      out.push(String(node))
      return
    }
    const { type, props } = node
    if (type === Fragment) {
      renderNode(props.children, parent, `${key}f`, out)
      return
    }
    if (typeof type === 'function') {
      const instance = child(parent, key)
      const outer = current
      current = instance
      instance.cursor = 0
      instance.pending = []
      let output
      try {
        output = type(props)
      } finally {
        current = outer
      }
      queued.push(...instance.pending)
      renderNode(output, instance, 'out', out)
      return
    }
    const element = { type, props: { ...props, children: undefined }, children: [] }
    renderNode(props.children, child(parent, key), 'c', element.children)
    out.push(element)
  }
  const React = {
    Fragment,
    createElement,
    useState(initial) {
      const entry = remember(initial)
      const setState = (next) => {
        const value = typeof next === 'function' ? next(entry.value) : next
        if (Object.is(value, entry.value)) return
        entry.value = value
        dirty = true
      }
      return [entry.value, setState]
    },
    useReducer(reducer, initialArg, init) {
      const entry = remember(() => (init ? init(initialArg) : initialArg))
      const dispatch = (action) => {
        const value = reducer(entry.value, action)
        if (Object.is(value, entry.value)) return
        entry.value = value
        dirty = true
      }
      return [entry.value, dispatch]
    },
    useRef(initial) {
      return remember(() => ({ current: initial })).value
    },
    useMemo(factory, deps) {
      const index = slot()
      if (changed(current.hooks[index], deps)) current.hooks[index] = { value: factory(), deps }
      return current.hooks[index].value
    },
    useCallback: (callback, deps) => React.useMemo(() => callback, deps),
    useEffect: effect,
    useLayoutEffect: effect,
    useSyncExternalStore(subscribe, getSnapshot) {
      const index = slot()
      if (!(index in current.hooks)) {
        current.hooks[index] = { unsubscribe: subscribe(() => {
          dirty = true
        }) }
      }
      return getSnapshot()
    },
    useId: () => remember(() => `fake-react-${(idCounter += 1)}`).value,
  }
  const roots = new Map()
  return {
    React,
    /**
     * Render one element tree, repeating while its state or stores still change.
     *
     * @param {object} element - root element.
     * @param {string} [id] - identity whose component instances survive between calls.
     * @returns {object|null} host tree, or null when the component renders nothing.
     */
    render(element, id = 'root') {
      if (!roots.has(id)) roots.set(id, createInstance())
      const root = roots.get(id)
      let tree = null
      for (let pass = 0; pass < 60; pass += 1) {
        dirty = false
        const out = []
        renderNode(element, root, 'root', out)
        tree = out[0] ?? null
        const effects = queued
        queued = []
        for (const run of effects) run()
        if (!dirty) return tree
      }
      throw new Error('fake React: the tree did not settle')
    },
  }
}

/** Load the client bundle the way the DSH page does and hand back what it registered. */
function loadClient() {
  const registered = { dictionaries: null, slots: new Map() }
  const locale = {
    bind: (namespace) => (key, params = {}) => {
      const table = registered.dictionaries?.[namespace]?.zh ?? {}
      const template = Object.hasOwn(table, key) ? table[key] : key
      return template.replace(/\{(\w+)\}/g, (whole, name) => (Object.hasOwn(params, name) ? String(params[name]) : whole))
    },
    register: (namespace, dictionaries) => {
      registered.dictionaries = { ...registered.dictionaries, [namespace]: dictionaries }
    },
  }
  const ctx = {
    locale,
    slots: {
      inject: (_name, register) => register(),
      register: (descriptor, component) => registered.slots.set(`${descriptor.name}:${descriptor.id ?? descriptor.key}`, { descriptor, component }),
    },
    // Effects are recorded, not run: they touch the DOM. The one that
    // registers the dictionaries is the exception.
    effect: (apply, label) => {
      if (String(label).includes('dictionaries')) apply()
      return () => {}
    },
    commandUi: { register: () => () => {} },
    get: (name) => (name === 'commandUi' ? ctx.commandUi : undefined),
  }
  let definition = null
  vm.runInNewContext(
    source,
    {
      window: {
        __ModuleLoader__: {
          load: (value) => {
            definition = value
          },
        },
      },
      console,
      // The bundle reads the clock through `Date.now()`: pin it, so timing
      // phrases do not drift with the real time.
      Date: class extends Date {
        static now() {
          return NOW
        }
      },
      // Timers never fire: nothing scheduled by the components keeps the test alive.
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
    },
    { filename: 'client.js' },
  )
  assert.ok(definition, 'the bundle hands a definition to the module loader')
  const fake = createFakeReact()
  const client = definition.factory((name) => {
    assert.equal(name, 'react', 'the client imports nothing but react')
    return fake.React
  })
  client.apply(ctx)
  return { ...registered, render: fake.render, React: fake.React, t: locale.bind('offpeakQueue') }
}

const client = loadClient()
const { React, render } = client

// ── tree readers ───────────────────────────────────────────────────────────

const hasClass = (name) => (node) => typeof node?.type === 'string' && String(node.props.className ?? '').split(/\s+/).includes(name)
const textOf = (node) =>
  typeof node === 'string' ? node : Array.isArray(node) ? node.map(textOf).join('') : node && typeof node === 'object' ? textOf(node.children) : ''
const findAll = (node, predicate, found = []) => {
  if (!node || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const child of node.children ?? []) findAll(child, predicate, found)
  return found
}
const find = (node, predicate) => findAll(node, predicate)[0]
const buttonNamed = (label) => (node) => node.type === 'button' && textOf(node) === label

// ── dictionaries ───────────────────────────────────────────────────────────

const placeholdersOf = (template) => [...String(template).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()
const dictionaryKeySets = () => {
  const { zh, en } = client.dictionaries.offpeakQueue
  return { zh, en, zhKeys: Object.keys(zh).sort(), enKeys: Object.keys(en).sort() }
}

test('client bundle: both dictionaries carry the same keys and placeholders', () => {
  const { zh, en, zhKeys, enKeys } = dictionaryKeySets()
  assert.deepEqual(enKeys, zhKeys)
  for (const key of zhKeys) assert.deepEqual(placeholdersOf(en[key]), placeholdersOf(zh[key]), key)
  assert.ok(zhKeys.length > 100, 'the dictionary is loaded, not a stub')
})

test('client bundle: every t() key the script asks for is defined', () => {
  const { zh } = dictionaryKeySets()
  const literal = [...source.matchAll(/\bt\('([a-zA-Z0-9_.]+)'/g)].map((match) => match[1])
  assert.ok(literal.length > 100, 'the keys are found')
  for (const key of new Set(literal)) assert.ok(Object.hasOwn(zh, key), `missing zh key: ${key}`)
  // The one computed key: `taskBar.count.<status>` for each status the head counts.
  for (const status of ['running', 'queued', 'failed', 'cancelled']) {
    assert.ok(Object.hasOwn(zh, `taskBar.count.${status}`), `missing zh key: taskBar.count.${status}`)
  }
})

// ── conversation task bar ──────────────────────────────────────────────────

const MINUTE = 60_000
const NEXT_RUN = NOW + 60 * MINUTE

/** A detached snapshot task as the Host decorates it. */
const task = (id, status, fields = {}) => ({
  id,
  order: 0,
  title: `任务${id}`,
  prompt: `任务${id}的全文\n第二行`,
  content: [],
  status,
  modelFamily: 'deepseek',
  sourceSessionId: 'session-1',
  sourceWorkspaceId: 'ws-1',
  createdAt: NOW - 30 * MINUTE,
  updatedAt: NOW - 30 * MINUTE,
  startedAt: null,
  finishedAt: null,
  error: null,
  nextRunAt: status === 'queued' ? NEXT_RUN : null,
  ...fields,
})

/** A store the page's `useStore` can read, publishing a new snapshot on demand. */
function fakeStore(data) {
  const listeners = new Set()
  const state = { phase: 'ready', data, receivedAt: 1, serverOffset: 0 }
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: () => {
      for (const listener of Array.from(listeners)) listener()
    },
  }
}

/**
 * Mount the conversation task bar over an in-memory queue. `store.mutate`
 * applies the task action the way the Host does, then publishes a new snapshot.
 *
 * @param {object[]} tasks - snapshot tasks.
 * @param {string} [sessionId] - conversation the bar sits in.
 * @returns {object} the view: its tree, `click(label, rowIndex?)`, `settle()`, `store`.
 */
let mountCount = 0
function mountBar(tasks, sessionId = 'session-1') {
  const store = fakeStore({ now: NOW, settings: {}, tasks, counts: {}, workspaces: [], armed: [], families: [{ id: 'deepseek', enabled: true }] })
  const queue = store.getSnapshot().data
  Object.assign(store, {
    refresh: async () => {},
    retainFast: () => () => {},
    mutate: async (path) => {
      const match = /^\/tasks\/([^/]+)\/(cancel|retry|delete)$/.exec(path)
      if (!match) throw new Error(`unexpected request: ${path}`)
      const [, id, action] = match
      const index = queue.tasks.findIndex((entry) => entry.id === id)
      if (index === -1) throw new Error('任务不存在')
      const entry = { ...queue.tasks[index], updatedAt: NOW + 1 }
      if (action === 'cancel') Object.assign(entry, { status: 'cancelled', finishedAt: NOW + 1 })
      if (action === 'retry') Object.assign(entry, { status: 'queued', finishedAt: null, nextRunAt: NEXT_RUN })
      if (action === 'delete') queue.tasks.splice(index, 1)
      else queue.tasks[index] = entry
      store.publish()
    },
  })
  const toasts = []
  const element = React.createElement(client.slots.get('conversation.input.dock:offpeak-task').component, {
    store,
    t: client.t,
    sessionId,
    toasts: { push: (kind, message) => toasts.push({ kind, message }) },
  })
  const rootId = `bar:${(mountCount += 1)}`
  const view = { toasts, store, tree: null }
  view.show = () => {
    view.tree = render(element, rootId)
    return view.tree
  }
  view.settle = async () => {
    for (let turn = 0; turn < 4; turn += 1) {
      await Promise.resolve()
      await new Promise((resolve) => setImmediate(resolve))
    }
    return view.show()
  }
  /** Click the first button whose text is `label`, optionally inside one task row. */
  view.click = async (label, rowIndex = undefined) => {
    const scope = rowIndex === undefined ? view.tree : rows(view.tree)[rowIndex]
    const button = find(scope, buttonNamed(label))
    assert.ok(button, `no button "${label}" in ${rowIndex === undefined ? 'the bar' : `row ${rowIndex}`}`)
    button.props.onClick({ stopPropagation: () => {} })
    return view.settle()
  }
  view.show()
  return view
}

const bar = (tree) => find(tree, hasClass('dsh-oq-taskBar'))
const rows = (tree) => findAll(tree, hasClass('dsh-oq-taskBarRow'))
const rowTitles = (tree) => rows(tree).map((row) => textOf(find(row, hasClass('dsh-oq-taskBarRowTitle'))))
const rowStatuses = (tree) => rows(tree).map((row) => row.props['data-status'])
const rowButtons = (tree, index) => findAll(rows(tree)[index], (node) => node.type === 'button' && hasClass('dsh-oq-btn')(node)).map(textOf)
const headText = (tree) => textOf(find(tree, hasClass('dsh-oq-taskBarHead')))
const barAttribute = (tree, name) => bar(tree)?.props[name]

test('task bar: one task stays the single line with its own actions', async () => {
  const view = mountBar([task('a', 'queued')])
  assert.deepEqual(rowTitles(view.tree), [])
  assert.equal(headText(view.tree), '闲时任务已排队DeepSeek任务a预计 今天 12:00 执行')
  assert.equal(barAttribute(view.tree, 'data-expanded'), 'false')
  await view.click(headText(view.tree))
  assert.equal(barAttribute(view.tree, 'data-expanded'), 'true')
  assert.ok(find(view.tree, buttonNamed('修改')), 'the single task keeps its edit action')
  assert.ok(find(view.tree, buttonNamed('取消任务')), 'the single task keeps its cancel action')
})

test('task bar: several tasks are listed in submission order, each with its own actions', async () => {
  const view = mountBar([
    task('c', 'queued', { createdAt: NOW - 10 * MINUTE, title: '第三个提交' }),
    task('a', 'queued', { createdAt: NOW - 30 * MINUTE, title: '第一个提交' }),
    task('b', 'queued', { createdAt: NOW - 20 * MINUTE, title: '第二个提交' }),
  ])
  assert.equal(headText(view.tree), '闲时任务 · 3 个排队预计 今天 12:00 执行')
  assert.equal(barAttribute(view.tree, 'data-expanded'), 'false', 'a list of live tasks starts compact')
  await view.click(headText(view.tree))
  assert.deepEqual(rowTitles(view.tree), ['第一个提交', '第二个提交', '第三个提交'], 'rows follow when the tasks were submitted')
  assert.deepEqual(rowStatuses(view.tree), ['queued', 'queued', 'queued'])
  for (let index = 0; index < 3; index += 1) assert.deepEqual(rowButtons(view.tree, index), ['修改', '取消任务'])
})

test('task bar: cancelling one row leaves the others where they were and the list open', async () => {
  const view = mountBar([task('a', 'queued'), task('b', 'queued', { createdAt: NOW - 20 * MINUTE }), task('c', 'queued', { createdAt: NOW - 10 * MINUTE })])
  await view.click(headText(view.tree))
  await view.click('取消任务', 1)
  assert.deepEqual(rowStatuses(view.tree), ['queued', 'cancelled', 'queued'], 'the cancelled task keeps its row')
  assert.deepEqual(rowTitles(view.tree), ['任务a', '任务b', '任务c'])
  assert.equal(headText(view.tree), '闲时任务 · 2 个排队 · 1 个已取消预计 今天 12:00 执行')
  assert.equal(barAttribute(view.tree, 'data-expanded'), 'true', 'cancelling does not close the list')
  assert.deepEqual(rowButtons(view.tree, 1), ['重新入队', '删除', '×'])
  await view.click('取消任务', 0)
  await view.click('取消任务', 2)
  assert.deepEqual(rowStatuses(view.tree), ['cancelled', 'cancelled', 'cancelled'], 'three cancels in place, one row each')
  assert.deepEqual(rowTitles(view.tree), ['任务a', '任务b', '任务c'])
  assert.equal(headText(view.tree), '闲时任务 · 3 个已取消')
  assert.equal(barAttribute(view.tree, 'data-status'), 'cancelled')
})

test('task bar: a task queued again stays in place, and closing rows never brings an older one back', async () => {
  const view = mountBar([task('a', 'cancelled', { finishedAt: NOW - MINUTE }), task('b', 'queued', { createdAt: NOW - 20 * MINUTE })])
  assert.equal(barAttribute(view.tree, 'data-expanded'), 'true', 'a list with a cancelled task opens on its own')
  assert.deepEqual(rowStatuses(view.tree), ['cancelled', 'queued'])
  await view.click('重新入队', 0)
  assert.deepEqual(rowStatuses(view.tree), ['queued', 'queued'], 'queuing again keeps the row')
  assert.deepEqual(rowTitles(view.tree), ['任务a', '任务b'])
  // Cancel both, then close them one at a time: what is left is exactly what the list still shows.
  await view.click('取消任务', 0)
  await view.click('取消任务', 1)
  await view.click('×', 0)
  assert.equal(headText(view.tree), '闲时任务已取消DeepSeek任务b取消于 今天 11:00', 'one row left: the single line shows that task and nothing older')
  assert.deepEqual(rowTitles(view.tree), [])
  assert.deepEqual(findAll(view.tree, buttonNamed('×')).length, 1)
  await view.click('×')
  assert.equal(view.tree, null, 'closing the last cancelled row removes the bar')
})

test('task bar: deleting from a row asks for confirmation and removes only that row', async () => {
  const view = mountBar([task('a', 'cancelled', { finishedAt: NOW - MINUTE }), task('b', 'cancelled', { createdAt: NOW - 20 * MINUTE, finishedAt: NOW - MINUTE })])
  await view.click('删除', 1)
  assert.deepEqual(rowTitles(view.tree), ['任务a', '任务b'], 'the first click only arms the confirmation')
  assert.ok(find(rows(view.tree)[1], buttonNamed('确认删除')), 'the row asks to confirm')
  await view.click('确认删除', 1)
  assert.deepEqual(rowTitles(view.tree), [], 'the second click deletes that task; one row is left, so the bar is the single line again')
  assert.equal(headText(view.tree), '闲时任务已取消DeepSeek任务a取消于 今天 10:59')
})

test('task bar: rows ignore status when ordering, and the glyph follows the most urgent row', () => {
  const view = mountBar([
    task('a', 'cancelled', { finishedAt: NOW - MINUTE }),
    task('b', 'running', { createdAt: NOW - 20 * MINUTE, startedAt: NOW - 3 * MINUTE }),
    task('c', 'queued', { createdAt: NOW - 10 * MINUTE }),
  ])
  assert.deepEqual(rowTitles(view.tree), ['任务a', '任务b', '任务c'])
  assert.deepEqual(rowStatuses(view.tree), ['cancelled', 'running', 'queued'])
  assert.equal(headText(view.tree), '闲时任务 · 1 个执行中 · 1 个排队 · 1 个已取消预计 今天 12:00 执行')
  assert.equal(barAttribute(view.tree, 'data-status'), 'running')
  const failed = mountBar([task('a', 'queued'), task('b', 'failed', { createdAt: NOW - 5 * MINUTE, finishedAt: NOW - MINUTE, error: '模型请求失败' })])
  assert.equal(barAttribute(failed.tree, 'data-status'), 'failed')
  assert.ok(textOf(failed.tree).includes('模型请求失败'), 'a failed row shows why it failed')
  assert.ok(textOf(failed.tree).includes('失败于 今天 10:59'), 'a failed task says when it failed, not when it "finished"')
})

test('task bar: the list opens when a task newly needs attention, and otherwise keeps the choice made', async () => {
  const view = mountBar([task('a', 'queued'), task('b', 'queued', { createdAt: NOW - 20 * MINUTE })])
  await view.click(headText(view.tree))
  // A cancel made in the panel arrives through the snapshot while the bar is open.
  await view.store.mutate('/tasks/b/cancel')
  await view.settle()
  assert.equal(barAttribute(view.tree, 'data-expanded'), 'true')
  await view.click(headText(view.tree))
  assert.equal(barAttribute(view.tree, 'data-expanded'), 'false', 'the user may close the list again')
  await view.store.mutate('/tasks/a/cancel')
  await view.settle()
  assert.equal(barAttribute(view.tree, 'data-expanded'), 'true', 'a second task needing attention opens the list again')
})

test('task bar: tasks of other conversations and finished ones stay out of the bar', () => {
  const view = mountBar([task('mine', 'queued'), task('theirs', 'queued', { sourceSessionId: 'session-2' }), task('done', 'done', { finishedAt: NOW - MINUTE })])
  assert.equal(headText(view.tree), '闲时任务已排队DeepSeek任务mine预计 今天 12:00 执行')
  assert.deepEqual(rowTitles(view.tree), [])
})

// ── panel queue tab ────────────────────────────────────────────────────────

test('panel 「全部」: tasks by creation time, newest first', () => {
  const data = { now: NOW, settings: {}, tasks: [
    task('old', 'done', { createdAt: NOW - 50 * MINUTE, title: '最早', updatedAt: NOW - MINUTE }),
    task('mid', 'queued', { createdAt: NOW - 20 * MINUTE, title: '居中' }),
    task('new', 'cancelled', { createdAt: NOW - 5 * MINUTE, title: '最新' }),
  ], counts: {}, workspaces: [], armed: [], families: [] }
  const flag = fakeStore(false)
  flag.getSnapshot = () => false
  const seen = fakeStore(null)
  Object.assign(seen, { mark: () => {} })
  const element = React.createElement(client.slots.get('main:offpeak').component, {
    store: fakeStore(data),
    statsStore: fakeStore({}),
    seenStore: seen,
    settingsFlag: flag,
    t: client.t,
    onOpenSession: () => {},
    sessionLabel: () => '',
    onCreateTask: async () => 'session-9',
  })
  const titles = findAll(render(element, 'page'), hasClass('dsh-oq-row')).map((row) => textOf(find(row, hasClass('dsh-oq-rowTitle'))))
  assert.deepEqual(titles, ['最新', '居中', '最早'], 'not by last update, which would put the long-finished task on top')
})
