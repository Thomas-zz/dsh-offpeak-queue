/**
 * Unit tests for the pure billing-period calendar in `host/policy.js`.
 *
 * All expectations are wall-clock times in the settings time zone; epoch
 * values are built with explicit offsets so the tests never depend on the
 * machine's local time zone.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_HOLIDAYS,
  DEFAULT_SETTINGS,
  SettingsError,
  formatRule,
  nextOffpeakStart,
  normalizeSettings,
  resolvePeriod,
} from '../host/policy.js'

/**
 * Convert a Beijing-time ISO string to epoch milliseconds.
 *
 * @param {string} iso - e.g. `2026-11-03T09:00:00+08:00`.
 * @returns {number} epoch milliseconds.
 */
function bj(iso) {
  return Date.parse(iso)
}

/**
 * Format epoch milliseconds as Beijing wall-clock time for assertion messages.
 *
 * @param {number} ms - epoch milliseconds.
 * @returns {string} `YYYY-MM-DD HH:mm:ss` Beijing time.
 */
function show(ms) {
  if (ms === null || ms === undefined) return 'null'
  return new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

const settings = normalizeSettings({})

test('default settings follow the official DeepSeek rule', () => {
  assert.equal(settings.timeZone, 'Asia/Shanghai')
  assert.equal(settings.autoRun, true)
  assert.equal(settings.maxConcurrent, 3)
  assert.equal(settings.taskTimeoutMinutes, 120)
  assert.deepEqual(settings.peakWindows, [
    { weekdays: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
    { weekdays: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
  ])
  assert.deepEqual(settings.holidays, [...DEFAULT_HOLIDAYS])
  assert.deepEqual(settings.holidayYears, [2026])
  assert.equal(settings.permissionPreset, null)
  assert.deepEqual(settings.prices, {
    'deepseek-flash': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
    'deepseek-v4-pro': { cacheHit: 0.3, cacheMiss: 9, output: 27 },
    'deepseek-reasoner': { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  })
  assert.equal(settings.pricesVerifiedAt, '2026-10-10')
})

test('peak window boundaries are half-open on a weekday', () => {
  const cases = [
    ['2026-11-03T08:59:59+08:00', 'offpeak'],
    ['2026-11-03T09:00:00+08:00', 'peak'],
    ['2026-11-03T11:59:59+08:00', 'peak'],
    ['2026-11-03T12:00:00+08:00', 'offpeak'],
    ['2026-11-03T13:59:59+08:00', 'offpeak'],
    ['2026-11-03T14:00:00+08:00', 'peak'],
    ['2026-11-03T17:59:59+08:00', 'peak'],
    ['2026-11-03T18:00:00+08:00', 'offpeak'],
  ]
  for (const [iso, expected] of cases) {
    const period = resolvePeriod(bj(iso), settings)
    assert.equal(period.kind, expected, `${iso} -> ${period.kind} (expected ${expected})`)
  }
})

test('snapshot weekday uses getDay numbering (0=Sunday)', () => {
  assert.equal(resolvePeriod(bj('2026-11-03T12:00:00+08:00'), settings).weekday, 2)
  assert.equal(resolvePeriod(bj('2026-11-08T12:00:00+08:00'), settings).weekday, 0)
  assert.equal(resolvePeriod(bj('2026-11-07T12:00:00+08:00'), settings).weekday, 6)
})

test('nextChangeAt is the next peak/off-peak flip', () => {
  assert.equal(resolvePeriod(bj('2026-11-03T08:00:00+08:00'), settings).nextChangeAt, bj('2026-11-03T09:00:00+08:00'))
  assert.equal(resolvePeriod(bj('2026-11-03T10:00:00+08:00'), settings).nextChangeAt, bj('2026-11-03T12:00:00+08:00'))
  assert.equal(resolvePeriod(bj('2026-11-03T13:00:00+08:00'), settings).nextChangeAt, bj('2026-11-03T14:00:00+08:00'))
  assert.equal(resolvePeriod(bj('2026-11-03T17:00:00+08:00'), settings).nextChangeAt, bj('2026-11-03T18:00:00+08:00'))
  assert.equal(resolvePeriod(bj('2026-11-03T23:00:00+08:00'), settings).nextChangeAt, bj('2026-11-04T09:00:00+08:00'))
})

test('weekend is off-peak all day and reasons are reported', () => {
  for (const iso of ['2026-11-07T09:30:00+08:00', '2026-11-08T14:30:00+08:00']) {
    const period = resolvePeriod(bj(iso), settings)
    assert.equal(period.kind, 'offpeak', iso)
    assert.equal(period.reason, 'weekend', iso)
  }
  assert.equal(resolvePeriod(bj('2026-11-07T10:00:00+08:00'), settings).nextChangeAt, bj('2026-11-09T09:00:00+08:00'))
})

test('statutory holiday is off-peak all day even during a weekday window', () => {
  for (const iso of ['2026-10-01T09:30:00+08:00', '2026-10-01T15:00:00+08:00']) {
    const period = resolvePeriod(bj(iso), settings)
    assert.equal(period.kind, 'offpeak', iso)
    assert.equal(period.reason, 'holiday', iso)
  }
  assert.equal(resolvePeriod(bj('2026-10-01T00:00:00+08:00'), settings).kind, 'offpeak')
})

test('a non-holiday weekday outside windows reports offpeak-window', () => {
  const period = resolvePeriod(bj('2026-11-03T08:00:00+08:00'), settings)
  assert.equal(period.kind, 'offpeak')
  assert.equal(period.reason, 'offpeak-window')
  assert.equal(period.windowStartAt, bj('2026-11-02T18:00:00+08:00'))
  assert.equal(period.windowEndAt, bj('2026-11-03T09:00:00+08:00'))
  assert.equal(period.nextOffpeakAt, bj('2026-11-03T08:00:00+08:00'))
})

test('off-peak stretch crosses midnight and reports its bounds', () => {
  const late = resolvePeriod(bj('2026-11-03T23:30:00+08:00'), settings)
  assert.equal(late.kind, 'offpeak')
  assert.equal(late.windowStartAt, bj('2026-11-03T18:00:00+08:00'))
  assert.equal(late.windowEndAt, bj('2026-11-04T09:00:00+08:00'))
  assert.equal(show(late.windowEndAt), '2026-11-04 09:00:00')

  const early = resolvePeriod(bj('2026-11-04T06:00:00+08:00'), settings)
  assert.equal(early.kind, 'offpeak')
  assert.equal(early.windowStartAt, bj('2026-11-03T18:00:00+08:00'))
  assert.equal(early.windowEndAt, bj('2026-11-04T09:00:00+08:00'))
})

test('Friday evening off-peak stretch runs to Monday 09:00', () => {
  const period = resolvePeriod(bj('2026-11-06T18:00:00+08:00'), settings)
  assert.equal(period.kind, 'offpeak')
  assert.equal(period.windowStartAt, bj('2026-11-06T18:00:00+08:00'))
  assert.equal(period.windowEndAt, bj('2026-11-09T09:00:00+08:00'))
  assert.equal(period.nextChangeAt, bj('2026-11-09T09:00:00+08:00'))
})

test('nextOffpeakStart equals now while off-peak and the peak end while peak', () => {
  assert.equal(nextOffpeakStart(bj('2026-11-03T08:00:00+08:00'), settings), bj('2026-11-03T08:00:00+08:00'))
  assert.equal(nextOffpeakStart(bj('2026-11-03T10:30:00+08:00'), settings), bj('2026-11-03T12:00:00+08:00'))
  assert.equal(nextOffpeakStart(bj('2026-11-07T10:30:00+08:00'), settings), bj('2026-11-07T10:30:00+08:00'))
})

test('a custom window crossing midnight splits into both local days', () => {
  const custom = normalizeSettings({
    peakWindows: [{ weekdays: [1], start: '23:00', end: '01:00' }],
  }, settings)
  const mondayLate = resolvePeriod(bj('2026-11-02T23:30:00+08:00'), custom)
  assert.equal(mondayLate.kind, 'peak', 'Monday 23:30 inside 23:00-01:00')
  assert.equal(mondayLate.nextChangeAt, bj('2026-11-03T01:00:00+08:00'))
  const tuesdayEarly = resolvePeriod(bj('2026-11-03T00:30:00+08:00'), custom)
  assert.equal(tuesdayEarly.kind, 'peak', 'Tuesday 00:30 is the overnight part of Monday window')
  assert.equal(resolvePeriod(bj('2026-11-02T22:59:00+08:00'), custom).kind, 'offpeak')
  assert.equal(resolvePeriod(bj('2026-11-03T01:00:00+08:00'), custom).kind, 'offpeak')
})

test('timeZone setting controls the calendar (America/New_York)', () => {
  const newYork = normalizeSettings({ timeZone: 'America/New_York' }, settings)
  // 2026-11-03 is after the US DST switch, so EST (-05:00).
  assert.equal(resolvePeriod(Date.parse('2026-11-03T10:00:00-05:00'), newYork).kind, 'peak')
  assert.equal(resolvePeriod(Date.parse('2026-11-03T12:00:00-05:00'), newYork).kind, 'offpeak')
  assert.equal(resolvePeriod(Date.parse('2026-11-03T10:00:00-05:00'), newYork).dateKey, '2026-11-03')
})

test('normalizeSettings merges partial patches and derives holiday coverage', () => {
  const patched = normalizeSettings({ autoRun: false, maxConcurrent: 3, taskTimeoutMinutes: 30 }, settings)
  assert.equal(patched.autoRun, false)
  assert.equal(patched.maxConcurrent, 3)
  assert.equal(patched.taskTimeoutMinutes, 30)
  assert.equal(patched.timeZone, 'Asia/Shanghai', 'untouched keys keep their values')

  const holidays = normalizeSettings({ holidays: ['2027-01-01', '2026-12-31', '2027-01-01'] }, settings)
  assert.deepEqual(holidays.holidays, ['2026-12-31', '2027-01-01'])
  assert.deepEqual(holidays.holidayYears, [2026, 2027])

  const cleared = normalizeSettings({ holidays: [] }, settings)
  assert.deepEqual(cleared.holidays, [])
  assert.deepEqual(cleared.holidayYears, [])

  const priced = normalizeSettings({
    prices: { 'deepseek-v4-pro': { cacheHit: 0.25, cacheMiss: 8, output: 24 }, 'my-model': { cacheHit: 1, cacheMiss: 2, output: 3 } },
    pricesVerifiedAt: '2026-11-01',
  }, settings)
  assert.deepEqual(priced.prices['deepseek-v4-pro'], { cacheHit: 0.25, cacheMiss: 8, output: 24 })
  assert.deepEqual(priced.prices['deepseek-flash'], { cacheHit: 0.04, cacheMiss: 2, output: 8 }, 'untouched entries keep their prices')
  assert.equal(priced.prices['my-model'].cacheMiss, 2, 'new models are added')
  assert.equal(priced.pricesVerifiedAt, '2026-11-01')
})

test('normalizeSettings rejects invalid input with Chinese messages', () => {
  const invalid = [
    [{ maxConcurrent: 6 }, /maxConcurrent/],
    [{ maxConcurrent: 1.5 }, /maxConcurrent/],
    [{ taskTimeoutMinutes: 4 }, /taskTimeoutMinutes/],
    [{ taskTimeoutMinutes: 721 }, /taskTimeoutMinutes/],
    [{ autoRun: 'yes' }, /autoRun/],
    [{ timeZone: 'Not/AZone' }, /timeZone/],
    [{ timeZone: '' }, /timeZone/],
    [{ peakWindows: 'nope' }, /peakWindows/],
    [{ peakWindows: [{ weekdays: [], start: '09:00', end: '12:00' }] }, /weekdays/],
    [{ peakWindows: [{ weekdays: [0], start: '09:00', end: '12:00' }] }, /weekdays/],
    [{ peakWindows: [{ weekdays: [8], start: '09:00', end: '12:00' }] }, /weekdays/],
    [{ peakWindows: [{ weekdays: [1], start: '9:00', end: '12:00' }] }, /start/],
    [{ peakWindows: [{ weekdays: [1], start: '09:00', end: '09:00' }] }, /相同/],
    [{ peakWindows: [{ weekdays: [1], start: '09:00', end: '12:00', extra: 1 }] }, /未知字段/],
    [{ holidays: ['2026-13-01'] }, /节假日/],
    [{ holidays: ['not-a-date'] }, /节假日/],
    [{ unknownSetting: true }, /未知的设置项/],
    [{ permissionPreset: 3 }, /permissionPreset/],
    [{ prices: 'nope' }, /prices/],
    [{ prices: { x: { cacheHit: -1, cacheMiss: 1, output: 1 } } }, /cacheHit/],
    [{ prices: { x: { cacheHit: 1 } } }, /cacheMiss/],
    [{ prices: { x: { cacheHit: 1, cacheMiss: 1, output: 1, extra: 1 } } }, /未知字段/],
    [{ pricesVerifiedAt: 42 }, /pricesVerifiedAt/],
  ]
  for (const [partial, expected] of invalid) {
    assert.throws(
      () => normalizeSettings(partial, settings),
      (error) => {
        assert.ok(error instanceof SettingsError, `expected SettingsError for ${JSON.stringify(partial)}`)
        if (expected) assert.match(error.message, expected)
        return true
      },
    )
  }
  assert.equal(normalizeSettings({ peakWindows: [] }, settings).peakWindows.length, 0, 'empty window list is allowed')
  assert.equal(normalizeSettings({ permissionPreset: '' }, settings).permissionPreset, null)
})

test('DST fall-back keeps true local peak boundaries and off-peak stretch ends', () => {
  const newYork = normalizeSettings({ timeZone: 'America/New_York' }, settings)
  // 2026-11-01 fall back at 02:00 EDT; Nov 3 is Tuesday EST (UTC-5).
  assert.equal(resolvePeriod(Date.UTC(2026, 10, 3, 14, 0), newYork).kind, 'peak', 'Nov 3 09:00 EST is peak')
  assert.equal(resolvePeriod(Date.UTC(2026, 10, 3, 13, 59, 59), newYork).kind, 'offpeak', 'Nov 3 08:59:59 EST is off-peak')
  assert.equal(resolvePeriod(Date.UTC(2026, 10, 3, 16, 59, 59), newYork).kind, 'peak')
  assert.equal(resolvePeriod(Date.UTC(2026, 10, 3, 17, 0), newYork).kind, 'offpeak', 'Nov 3 12:00 EST ends the window')
  // Lead-reported epoch: Nov 3 12:00 EST = 17:00Z.
  assert.equal(resolvePeriod(Date.UTC(2026, 10, 3, 14, 0), newYork).nextChangeAt, Date.UTC(2026, 10, 3, 17, 0))
  // Fri Oct 30 18:00 EDT -> fall-back weekend -> Mon Nov 2 09:00 EST (14:00Z).
  const friday = resolvePeriod(Date.parse('2026-10-30T18:00:00-04:00'), newYork)
  assert.equal(friday.kind, 'offpeak')
  assert.equal(friday.windowEndAt, Date.UTC(2026, 10, 2, 14, 0))
  const sunday = resolvePeriod(Date.UTC(2026, 10, 1, 15, 0), newYork)
  assert.equal(sunday.kind, 'offpeak')
  assert.equal(sunday.reason, 'weekend')
  assert.equal(sunday.nextChangeAt, Date.UTC(2026, 10, 2, 14, 0))
})

test('DST spring-forward keeps true local peak boundaries and off-peak stretch ends', () => {
  const newYork = normalizeSettings({ timeZone: 'America/New_York' }, settings)
  // 2026-03-08 spring forward at 02:00 EST; Mar 9 is Monday EDT (UTC-4).
  assert.equal(resolvePeriod(Date.UTC(2026, 2, 9, 13, 0), newYork).kind, 'peak', 'Mar 9 09:00 EDT is peak')
  assert.equal(resolvePeriod(Date.UTC(2026, 2, 9, 12, 59, 59), newYork).kind, 'offpeak', 'Mar 9 08:59:59 EDT is off-peak')
  assert.equal(resolvePeriod(Date.UTC(2026, 2, 9, 13, 0), newYork).nextChangeAt, Date.UTC(2026, 2, 9, 16, 0), 'Mar 9 12:00 EDT = 16:00Z')
  // Fri Mar 6 18:00 EST -> spring-forward weekend -> Mon Mar 9 09:00 EDT (13:00Z).
  const friday = resolvePeriod(Date.parse('2026-03-06T18:00:00-05:00'), newYork)
  assert.equal(friday.kind, 'offpeak')
  assert.equal(friday.windowEndAt, Date.UTC(2026, 2, 9, 13, 0))
  // A peak window spanning the transition day still starts/ends on the local clock.
  const dayBefore = resolvePeriod(Date.parse('2026-03-09T09:00:00-04:00'), newYork)
  assert.equal(dayBefore.kind, 'peak')
  assert.equal(dayBefore.nextChangeAt, Date.UTC(2026, 2, 9, 16, 0))
})

test('formatRule describes the effective rule', () => {
  const text = formatRule(settings)
  assert.match(text, /高峰（全价）/)
  assert.match(text, /时区 Asia\/Shanghai/)
  assert.match(text, /周一至周五 09:00-12:00、14:00-18:00/)
  assert.match(text, /闲时（半价/)
  assert.match(text, /2026 年已内置/)
  const custom = formatRule(normalizeSettings({ peakWindows: [{ weekdays: [6, 7], start: '10:00', end: '11:00' }] }, settings))
  assert.match(custom, /周六至周日 10:00-11:00/)
})

test('default settings are frozen and not mutated by normalization', () => {
  const before = JSON.stringify(DEFAULT_SETTINGS.peakWindows)
  normalizeSettings({ peakWindows: [{ weekdays: [3], start: '08:00', end: '09:00' }] }, settings)
  assert.equal(JSON.stringify(DEFAULT_SETTINGS.peakWindows), before)
})
