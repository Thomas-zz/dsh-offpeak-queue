/**
 * Pure DeepSeek billing-period calendar math for the off-peak queue.
 *
 * No I/O and no Host services: everything here is deterministic given a clock
 * value plus a normalized settings object, so `node --test` can cover the
 * boundaries without booting DSH.
 *
 * Billing rule (official docs, verified 2026-10-10): DeepSeek bills by the
 * completion instant. Peak = Monday–Friday (excluding Chinese statutory
 * holidays) 09:00–12:00 and 14:00–18:00 Beijing time; every other instant is
 * off-peak (half price). Windows are half-open `[start, end)`.
 *
 * Weekday conventions used by this module:
 * - settings `peakWindows[].weekdays` are ISO weekdays: 1=Monday … 7=Sunday.
 * - `period.weekday` in the snapshot is JavaScript `getDay()`: 0=Sunday … 6=Saturday.
 *
 * @module @zayn_/dsh-offpeak-queue/host/policy
 */

import { DEFAULT_PRICES, DEFAULT_PRICES_VERIFIED_AT, PricingError, mergePrices } from './pricing.js'
import { FAMILY_IDS, GLM_CALENDAR, defaultFamilyEnabled } from './families.js'

/** Milliseconds in one day. */
const MS_DAY = 24 * 60 * 60 * 1000

/** Milliseconds in one minute. */
const MS_MINUTE = 60 * 1000

/** Weekday names from `Intl` to JavaScript's `getDay()` numbering. */
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/** Fallback span used when a settings object has no peak windows at all. */
const NO_BOUNDARY_FALLBACK_MS = 365 * MS_DAY

/** Days generated before `now` when resolving a contiguous off-peak stretch. */
const STRETCH_LOOKBACK_DAYS = 45

/** Days generated after `now` when looking for the next billing flip. */
const CHANGE_LOOKAHEAD_DAYS = 400

/** Maximum number of recurring peak windows accepted by settings validation. */
const MAX_PEAK_WINDOWS = 20

/** Maximum number of holiday dates accepted by settings validation. */
const MAX_HOLIDAYS = 500

/** Strict `HH:mm` wall-clock time. */
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

/** `YYYY-MM-DD` calendar date. */
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

/** Every key the persisted settings object may carry. */
export const SETTINGS_KEYS = Object.freeze([
  'autoRun',
  'maxConcurrent',
  'taskTimeoutMinutes',
  'timeZone',
  'peakWindows',
  'holidays',
  'holidayYears',
  'permissionPreset',
  'prices',
  'pricesVerifiedAt',
  'familyEnabled',
])

/**
 * 2026 Chinese statutory holidays that fall on a weekday.
 * Weekends need no entry: they are already off-peak all day.
 * Source: State Council 2026 holiday schedule (official billing docs link).
 */
export const DEFAULT_HOLIDAYS = Object.freeze([
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
])

/** Default settings: the official DeepSeek rule for Beijing time. */
export const DEFAULT_SETTINGS = Object.freeze({
  autoRun: true,
  maxConcurrent: 3,
  taskTimeoutMinutes: 120,
  timeZone: 'Asia/Shanghai',
  peakWindows: Object.freeze([
    Object.freeze({ weekdays: Object.freeze([1, 2, 3, 4, 5]), start: '09:00', end: '12:00' }),
    Object.freeze({ weekdays: Object.freeze([1, 2, 3, 4, 5]), start: '14:00', end: '18:00' }),
  ]),
  holidays: DEFAULT_HOLIDAYS,
  holidayYears: Object.freeze([2026]),
  permissionPreset: null,
  prices: DEFAULT_PRICES,
  pricesVerifiedAt: DEFAULT_PRICES_VERIFIED_AT,
  familyEnabled: Object.freeze({ deepseek: true, glm: true }),
})

/**
 * Recoverable settings validation failure (bad shape, range, or time zone).
 * Callers map it to an HTTP 400 with its Chinese message.
 */
export class SettingsError extends Error {
  /**
   * @param {string} message - user-facing Chinese reason.
   */
  constructor(message) {
    super(message)
    this.name = 'SettingsError'
  }
}

/** Formatter cache keyed by IANA time zone. */
const formatterCache = new Map()

/**
 * Cached `Intl.DateTimeFormat` for one time zone.
 *
 * @param {string} timeZone - validated IANA zone.
 * @returns {Intl.DateTimeFormat} formatter producing wall-clock parts.
 */
function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    })
    formatterCache.set(timeZone, formatter)
  }
  return formatter
}

/**
 * Wall-clock parts of one instant in a time zone.
 *
 * @param {number} ms - epoch milliseconds.
 * @param {string} timeZone - IANA zone.
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: number}} parts.
 */
function zonedParts(ms, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms))
  const values = {}
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value
  }
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: WEEKDAY_INDEX[values.weekday] ?? 0,
  }
}

/**
 * Milliseconds that local wall clock runs ahead of UTC at one instant.
 *
 * @param {number} ms - epoch milliseconds (second precision is enough).
 * @param {string} timeZone - IANA zone.
 * @returns {number} offset in milliseconds.
 */
function offsetAt(ms, timeZone) {
  const whole = Math.floor(ms / 1000) * 1000
  const parts = zonedParts(whole, timeZone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
  return asUtc - whole
}

/**
 * `YYYY-MM-DD` key of the local date containing `ms`.
 *
 * @param {number} ms - epoch milliseconds.
 * @param {string} timeZone - IANA zone.
 * @returns {string} date key.
 */
function localDateKey(ms, timeZone) {
  const parts = zonedParts(ms, timeZone)
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

/**
 * `YYYY-MM-DD` key of the local date containing `ms` (public helper for stats
 * day buckets; same numbering as the snapshot `period.dateKey`).
 *
 * @param {number} ms - epoch milliseconds.
 * @param {string} timeZone - IANA zone.
 * @returns {string} local date key.
 */
export function dateKeyAt(ms, timeZone) {
  return localDateKey(ms, timeZone)
}

/**
 * ISO weekday (1=Monday … 7=Sunday) of the local date containing `ms`.
 *
 * @param {number} ms - epoch milliseconds.
 * @param {string} timeZone - IANA zone.
 * @returns {number} ISO weekday.
 */
function isoWeekday(ms, timeZone) {
  const day = zonedParts(ms, timeZone).weekday
  return day === 0 ? 7 : day
}

/**
 * Parse `HH:mm` into milliseconds after local midnight.
 *
 * @param {string} value - validated `HH:mm` string.
 * @returns {number} offset in milliseconds.
 */
function parseClock(value) {
  const match = TIME_PATTERN.exec(value)
  if (match === null) return 0
  return (Number(match[1]) * 60 + Number(match[2])) * MS_MINUTE
}

/**
 * Whether a string is an acceptable IANA time zone.
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} true when `Intl` accepts it.
 */
function isValidTimeZone(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    formatterFor(value)
    return true
  } catch {
    return false
  }
}

/**
 * Validate a `YYYY-MM-DD` string as a real calendar date.
 *
 * @param {unknown} value - candidate.
 * @returns {boolean} true for a real date.
 */
function isValidDateKey(value) {
  if (typeof value !== 'string') return false
  const match = DATE_PATTERN.exec(value)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

/**
 * Years covered by a holiday list, ascending and deduplicated.
 *
 * @param {string[]} holidays - validated date keys.
 * @returns {number[]} sorted years.
 */
function holidayYearsOf(holidays) {
  const years = new Set()
  for (const key of holidays) years.add(Number(key.slice(0, 4)))
  return [...years].sort((left, right) => left - right)
}

/**
 * Deep-copy one settings object into a fresh mutable record.
 *
 * @param {object} settings - settings-shaped object (not validated here).
 * @returns {object} detached copy.
 */
function cloneSettings(settings) {
  return {
    autoRun: settings.autoRun,
    maxConcurrent: settings.maxConcurrent,
    taskTimeoutMinutes: settings.taskTimeoutMinutes,
    timeZone: settings.timeZone,
    peakWindows: (settings.peakWindows ?? []).map((window) => ({
      weekdays: [...window.weekdays],
      start: window.start,
      end: window.end,
    })),
    holidays: [...(settings.holidays ?? [])],
    holidayYears: [...(settings.holidayYears ?? [])],
    permissionPreset: settings.permissionPreset ?? null,
    prices: Object.fromEntries(Object.entries(settings.prices ?? DEFAULT_PRICES).map(([model, entry]) => [model, { ...entry }])),
    pricesVerifiedAt: settings.pricesVerifiedAt ?? DEFAULT_PRICES_VERIFIED_AT,
    familyEnabled: (() => {
      const toggles = defaultFamilyEnabled()
      const source = settings.familyEnabled
      if (typeof source === 'object' && source !== null) {
        for (const id of FAMILY_IDS) {
          if (typeof source[id] === 'boolean') toggles[id] = source[id]
        }
      }
      return toggles
    })(),
  }
}

/**
 * Validate and normalize one peak-window entry.
 *
 * @param {unknown} value - candidate window.
 * @param {number} index - array index for messages.
 * @returns {{weekdays: number[], start: string, end: string}} normalized window.
 * @throws {SettingsError} on an invalid window.
 */
function normalizeWindow(value, index) {
  const label = `第 ${index + 1} 个高峰时段`
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SettingsError(`${label}必须是对象`)
  }
  for (const key of Object.keys(value)) {
    if (key !== 'weekdays' && key !== 'start' && key !== 'end') {
      throw new SettingsError(`${label}包含未知字段：${key}`)
    }
  }
  const weekdays = value.weekdays
  if (!Array.isArray(weekdays) || weekdays.length === 0) {
    throw new SettingsError(`${label}的 weekdays 必须是非空数组`)
  }
  const seen = new Set()
  for (const day of weekdays) {
    if (!Number.isInteger(day) || day < 1 || day > 7) {
      throw new SettingsError(`${label}的 weekdays 只能包含 1–7 的整数（1=周一）`)
    }
    seen.add(day)
  }
  const start = value.start
  const end = value.end
  if (typeof start !== 'string' || !TIME_PATTERN.test(start)) {
    throw new SettingsError(`${label}的 start 必须是 HH:mm`)
  }
  if (typeof end !== 'string' || !TIME_PATTERN.test(end)) {
    throw new SettingsError(`${label}的 end 必须是 HH:mm`)
  }
  if (parseClock(start) === parseClock(end)) {
    throw new SettingsError(`${label}的 start 和 end 不能相同`)
  }
  return {
    weekdays: [...seen].sort((left, right) => left - right),
    start,
    end,
  }
}

/**
 * Validate a partial settings patch against a base and return the effective
 * settings object. Unknown keys, out-of-range values, and invalid time zones
 * throw {@link SettingsError} with a Chinese message.
 *
 * `holidayYears` is accepted for round-tripping a whole snapshot back to the
 * server but is always derived from `holidays` (coverage metadata, not input).
 *
 * @param {object|null|undefined} partial - settings patch to apply.
 * @param {object} [base] - already-normalized settings used as defaults.
 * @returns {object} fresh normalized settings.
 * @throws {SettingsError} on invalid input.
 */
export function normalizeSettings(partial, base = DEFAULT_SETTINGS) {
  const settings = cloneSettings(base ?? DEFAULT_SETTINGS)
  if (partial === undefined || partial === null) {
    settings.holidayYears = holidayYearsOf(settings.holidays)
    return settings
  }
  if (typeof partial !== 'object' || Array.isArray(partial)) {
    throw new SettingsError('设置必须是对象')
  }
  for (const key of Object.keys(partial)) {
    if (!SETTINGS_KEYS.includes(key)) throw new SettingsError(`未知的设置项：${key}`)
  }
  if (Object.hasOwn(partial, 'autoRun')) {
    if (typeof partial.autoRun !== 'boolean') throw new SettingsError('autoRun 必须是布尔值')
    settings.autoRun = partial.autoRun
  }
  if (Object.hasOwn(partial, 'maxConcurrent')) {
    if (!Number.isInteger(partial.maxConcurrent) || partial.maxConcurrent < 1 || partial.maxConcurrent > 5) {
      throw new SettingsError('maxConcurrent 必须是 1–5 的整数')
    }
    settings.maxConcurrent = partial.maxConcurrent
  }
  if (Object.hasOwn(partial, 'taskTimeoutMinutes')) {
    const minutes = partial.taskTimeoutMinutes
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 720) {
      throw new SettingsError('taskTimeoutMinutes 必须是 5–720 的整数')
    }
    settings.taskTimeoutMinutes = minutes
  }
  if (Object.hasOwn(partial, 'timeZone')) {
    if (!isValidTimeZone(partial.timeZone)) throw new SettingsError('timeZone 不是有效的 IANA 时区')
    settings.timeZone = partial.timeZone
  }
  if (Object.hasOwn(partial, 'peakWindows')) {
    if (!Array.isArray(partial.peakWindows)) throw new SettingsError('peakWindows 必须是数组')
    if (partial.peakWindows.length > MAX_PEAK_WINDOWS) {
      throw new SettingsError(`peakWindows 最多 ${MAX_PEAK_WINDOWS} 条`)
    }
    settings.peakWindows = partial.peakWindows.map((window, index) => normalizeWindow(window, index))
  }
  if (Object.hasOwn(partial, 'holidays')) {
    if (!Array.isArray(partial.holidays)) throw new SettingsError('holidays 必须是数组')
    if (partial.holidays.length > MAX_HOLIDAYS) throw new SettingsError(`holidays 最多 ${MAX_HOLIDAYS} 条`)
    const unique = new Set()
    for (const entry of partial.holidays) {
      if (!isValidDateKey(entry)) throw new SettingsError(`节假日 ${String(entry)} 不是有效的 YYYY-MM-DD 日期`)
      unique.add(entry)
    }
    settings.holidays = [...unique].sort()
  }
  if (Object.hasOwn(partial, 'holidayYears')) {
    if (!Array.isArray(partial.holidayYears) || partial.holidayYears.some((year) => !Number.isInteger(year))) {
      throw new SettingsError('holidayYears 必须是整数数组')
    }
  }
  if (Object.hasOwn(partial, 'permissionPreset')) {
    const preset = partial.permissionPreset
    if (preset !== null && typeof preset !== 'string') throw new SettingsError('permissionPreset 必须是字符串或 null')
    settings.permissionPreset = preset === null || preset.trim() === '' ? null : preset.trim()
  }
  if (Object.hasOwn(partial, 'prices')) {
    try {
      settings.prices = mergePrices(partial.prices, settings.prices)
    } catch (error) {
      if (error instanceof PricingError) throw new SettingsError(error.message)
      throw error
    }
  }
  if (Object.hasOwn(partial, 'pricesVerifiedAt')) {
    const verifiedAt = partial.pricesVerifiedAt
    if (typeof verifiedAt !== 'string' || verifiedAt.trim() === '' || verifiedAt.length > 40) {
      throw new SettingsError('pricesVerifiedAt 必须是 1–40 个字符的字符串')
    }
    settings.pricesVerifiedAt = verifiedAt.trim()
  }
  if (Object.hasOwn(partial, 'familyEnabled')) {
    const value = partial.familyEnabled
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new SettingsError('familyEnabled 必须是对象（模型 id → 布尔开关）')
    }
    for (const key of Object.keys(value)) {
      if (!FAMILY_IDS.includes(key)) throw new SettingsError(`未知的模型开关：${key}`)
      if (typeof value[key] !== 'boolean') throw new SettingsError(`模型开关 ${key} 必须是布尔值`)
    }
    settings.familyEnabled = { ...settings.familyEnabled, ...value }
  }
  settings.holidayYears = holidayYearsOf(settings.holidays)
  return settings
}

/**
 * One billing interval `[start, end)` of peak time.
 *
 * @typedef {{start: number, end: number}} PeakInterval
 */

/** Milliseconds in one hour. */
const MS_HOUR = 60 * 60 * 1000

/**
 * Convert one local wall-clock date/time to epoch milliseconds, DST-safely.
 *
 * Two-pass offset resolution: guess with the offset at the provisional epoch,
 * then correct once with the offset at the resulting instant. This never
 * assumes a whole-day offset like `dayStart + minutes` would.
 *
 * @param {{year: number, month: number, day: number}} date - local calendar date.
 * @param {number} millisOfDay - wall-clock milliseconds after local midnight.
 * @param {string} timeZone - IANA zone.
 * @returns {number} epoch milliseconds of that local wall time.
 */
function localWallEpoch(date, millisOfDay, timeZone) {
  const hour = Math.floor(millisOfDay / MS_HOUR)
  const minute = Math.floor((millisOfDay % MS_HOUR) / MS_MINUTE)
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute)
  const firstOffset = offsetAt(guess, timeZone)
  let epoch = guess - firstOffset
  const secondOffset = offsetAt(epoch, timeZone)
  if (secondOffset !== firstOffset) epoch = guess - secondOffset
  return epoch
}

/**
 * Add whole days to one local calendar date using UTC calendar arithmetic
 * (never a fixed millisecond step, so DST transitions cannot drift it).
 *
 * @param {{year: number, month: number, day: number}} date - local calendar date.
 * @param {number} days - day delta.
 * @returns {{year: number, month: number, day: number}} shifted date.
 */
function addCalendarDays(date, days) {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days))
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }
}

/**
 * `YYYY-MM-DD` key of one local calendar date.
 *
 * @param {{year: number, month: number, day: number}} date - local date.
 * @returns {string} date key.
 */
function dateKeyOf(date) {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
}

/**
 * One billing interval `[start, end)` of peak time.
 *
 * @typedef {{start: number, end: number}} PeakInterval
 */

/**
 * Generate every peak interval overlapping `[fromMs, toMs]`.
 *
 * Iterates local calendar dates (calendar-day arithmetic, noon probes for
 * weekday/date identity, DST-safe wall-clock→epoch conversion), so zones with
 * daylight-saving transitions keep their true 09:00/14:00 local boundaries.
 * Handles same-day windows plus windows whose end is before their start by
 * splitting the overnight part into the following local day.
 *
 * @param {number} fromMs - lower bound (inclusive).
 * @param {number} toMs - upper bound (inclusive).
 * @param {object} settings - normalized settings.
 * @returns {PeakInterval[]} intervals sorted by start.
 */
function peakIntervals(fromMs, toMs, settings) {
  const timeZone = settings.timeZone
  const holidays = new Set(settings.holidays)
  const fromParts = zonedParts(fromMs, timeZone)
  const toParts = zonedParts(toMs, timeZone)
  const firstDate = addCalendarDays({ year: fromParts.year, month: fromParts.month, day: fromParts.day }, -1)
  const lastKey = dateKeyOf({ year: toParts.year, month: toParts.month, day: toParts.day })
  const intervals = []
  for (let date = firstDate; dateKeyOf(date) <= lastKey; date = addCalendarDays(date, 1)) {
    const dateKey = dateKeyOf(date)
    if (holidays.has(dateKey)) continue
    // Weekday identity from the wall date itself (UTC calendar arithmetic).
    const utcDay = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
    const isoDay = utcDay === 0 ? 7 : utcDay
    const nextDate = addCalendarDays(date, 1)
    const nextDayHoliday = holidays.has(dateKeyOf(nextDate))
    const nextDayStart = localWallEpoch(nextDate, 0, timeZone)
    for (const window of settings.peakWindows) {
      if (!window.weekdays.includes(isoDay)) continue
      const startMinute = parseClock(window.start)
      const endMinute = parseClock(window.end)
      if (startMinute < endMinute) {
        const start = localWallEpoch(date, startMinute, timeZone)
        const end = localWallEpoch(date, endMinute, timeZone)
        if (end > fromMs && start <= toMs) intervals.push({ start, end })
      } else {
        const start = localWallEpoch(date, startMinute, timeZone)
        if (nextDayStart > fromMs && start <= toMs) intervals.push({ start, end: nextDayStart })
        if (!nextDayHoliday) {
          const spillEnd = localWallEpoch(nextDate, endMinute, timeZone)
          if (spillEnd > fromMs && nextDayStart <= toMs) intervals.push({ start: nextDayStart, end: spillEnd })
        }
      }
    }
  }
  intervals.sort((left, right) => left.start - right.start)
  // Merge touching/overlapping intervals so a peak stretch that crosses
  // midnight (or back-to-back windows) counts as one billing flip.
  const merged = []
  for (const interval of intervals) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end)
    } else {
      merged.push({ start: interval.start, end: interval.end })
    }
  }
  return merged
}

/** Cached peak-interval lists keyed by calendar settings + UTC day bucket. */
const intervalCache = new Map()

/** Maximum cached calendar buckets kept in memory. */
const INTERVAL_CACHE_LIMIT = 8

/**
 * Stable cache key for the calendar-relevant settings.
 *
 * @param {object} settings - normalized settings.
 * @returns {string} cache key.
 */
function calendarKey(settings) {
  return `${settings.timeZone}|${JSON.stringify(settings.peakWindows)}|${settings.holidays.join(',')}`
}

/**
 * Peak intervals around `nowMs`, computed once per calendar bucket and
 * settings revision. The bucket is a UTC day; the generated range is generous
 * enough (45 days back, 400 days forward) that any instant inside the bucket
 * resolves exactly.
 *
 * @param {number} nowMs - epoch milliseconds.
 * @param {object} settings - normalized settings.
 * @returns {PeakInterval[]} peak intervals.
 */
function cachedPeakIntervals(nowMs, settings) {
  const bucket = Math.floor(nowMs / MS_DAY)
  const key = `${calendarKey(settings)}|${bucket}`
  const cached = intervalCache.get(key)
  if (cached !== undefined) return cached
  const bucketStart = bucket * MS_DAY
  const intervals = peakIntervals(
    bucketStart - STRETCH_LOOKBACK_DAYS * MS_DAY,
    bucketStart + CHANGE_LOOKAHEAD_DAYS * MS_DAY,
    settings,
  )
  if (intervalCache.size >= INTERVAL_CACHE_LIMIT) intervalCache.clear()
  intervalCache.set(key, intervals)
  return intervals
}

/**
 * Describe the billing period at one instant.
 *
 * @param {number} nowMs - epoch milliseconds.
 * @param {object} settings - normalized settings.
 * @returns {{
 *   kind: 'peak'|'offpeak',
 *   nextChangeAt: number,
 *   windowStartAt: number|null,
 *   windowEndAt: number|null,
 *   nextOffpeakAt: number,
 *   dateKey: string,
 *   weekday: number,
 *   reason: 'weekend'|'holiday'|'peak-window'|'offpeak-window',
 * }} period descriptor used by the snapshot.
 */
export function resolvePeriod(nowMs, settings) {
  const timeZone = settings.timeZone
  const now = Math.floor(nowMs)
  const intervals = cachedPeakIntervals(now, settings)
  const current = intervals.find((interval) => interval.start <= now && now < interval.end)
  const dateKey = localDateKey(now, timeZone)
  const weekday = zonedParts(now, timeZone).weekday
  const holidaySet = new Set(settings.holidays)

  if (current !== undefined) {
    return {
      kind: 'peak',
      nextChangeAt: current.end,
      windowStartAt: null,
      windowEndAt: null,
      nextOffpeakAt: current.end,
      dateKey,
      weekday,
      reason: 'peak-window',
    }
  }

  let windowStartAt = null
  let windowEndAt = null
  for (const interval of intervals) {
    if (interval.end <= now && (windowStartAt === null || interval.end > windowStartAt)) windowStartAt = interval.end
    if (interval.start > now && (windowEndAt === null || interval.start < windowEndAt)) windowEndAt = interval.start
  }
  if (windowStartAt === null) windowStartAt = now
  if (windowEndAt === null) windowEndAt = now + NO_BOUNDARY_FALLBACK_MS
  const nextChangeAt = windowEndAt

  let reason = 'offpeak-window'
  if (holidaySet.has(dateKey)) reason = 'holiday'
  else if (weekday === 0 || weekday === 6) reason = 'weekend'

  return {
    kind: 'offpeak',
    nextChangeAt,
    windowStartAt,
    windowEndAt,
    nextOffpeakAt: now,
    dateKey,
    weekday,
    reason,
  }
}

/**
 * Epoch milliseconds of the next off-peak start (equals `now` while already
 * off-peak), i.e. when a queued task may next begin.
 *
 * @param {number} nowMs - epoch milliseconds.
 * @param {object} settings - normalized settings.
 * @returns {number} epoch milliseconds.
 */
export function nextOffpeakStart(nowMs, settings) {
  const period = resolvePeriod(nowMs, settings)
  return period.kind === 'offpeak' ? Math.floor(nowMs) : period.nextChangeAt
}

/**
 * Human-readable billing rule for one family, used by tool output and the
 * settings page. The DeepSeek calendar follows the persisted settings; the GLM
 * calendar is the built-in Coding Plan rule.
 *
 * @param {'deepseek'|'glm'} familyId - family id.
 * @param {object} settings - normalized settings.
 * @returns {string} Chinese rule text.
 */
export function formatFamilyRule(familyId, settings) {
  if (familyId === 'glm') {
    const windows = GLM_CALENDAR.peakWindows.map((window) => `${window.start}-${window.end}`).join('、')
    return `GLM 高峰（全积分）：时区 ${GLM_CALENDAR.timeZone}，${formatWeekdays([1, 2, 3, 4, 5])} ${windows}；其余时间闲时（积分 5 折抵扣；官方规则未设节假日豁免）。`
  }
  return formatDeepSeekRule(settings)
}

/**
 * Human-readable DeepSeek billing rule (legacy single-family wording).
 *
 * @param {object} settings - normalized settings.
 * @returns {string} Chinese rule text.
 */
function formatDeepSeekRule(settings) {
  const timeZone = settings.timeZone
  const groups = new Map()
  for (const window of settings.peakWindows) {
    const key = window.weekdays.join(',')
    const list = groups.get(key) ?? []
    list.push(`${window.start}-${window.end}`)
    groups.set(key, list)
  }
  const parts = []
  for (const [key, windows] of groups) {
    const weekdays = key === '' ? [] : key.split(',').map(Number)
    const label = formatWeekdays(weekdays)
    windows.sort()
    parts.push(`${label} ${windows.join('、')}`)
  }
  const coverage = settings.holidayYears.length > 0
    ? `${settings.holidayYears.join('、')} 年已内置`
    : '未配置'
  const peak = parts.length > 0 ? parts.join('；') : '无（始终闲时）'
  return `DeepSeek 高峰（全价）：时区 ${timeZone}，${peak}；法定节假日（${coverage}，其他年份按工作日估算）全天闲时；其余时间闲时（半价，按完成时刻计费）。`
}

/**
 * Human-readable combined rule for every family, used by tool output.
 *
 * @param {object} settings - normalized settings.
 * @returns {string} Chinese rule text.
 */
export function formatRule(settings) {
  return FAMILY_IDS.map((familyId) => formatFamilyRule(familyId, settings)).join('\n')
}

/**
 * Compress ISO weekdays into a Chinese label, e.g. `周一至周五`.
 *
 * @param {number[]} weekdays - sorted ISO weekdays.
 * @returns {string} label.
 */
function formatWeekdays(weekdays) {
  const names = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
  if (weekdays.length === 0) return '每天'
  const sorted = [...weekdays].sort((left, right) => left - right)
  if (sorted.length === 7) return '每天'
  const ranges = []
  let runStart = sorted[0]
  let previous = sorted[0]
  for (let index = 1; index <= sorted.length; index += 1) {
    const day = sorted[index]
    if (day === previous + 1) {
      previous = day
      continue
    }
    ranges.push(runStart === previous ? names[runStart - 1] : `${names[runStart - 1]}至${names[previous - 1]}`)
    runStart = day
    previous = day
  }
  return ranges.join('、')
}
