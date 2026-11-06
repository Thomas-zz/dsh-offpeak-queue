/**
 * Unit tests for the model-family registry (`host/families.js`) and the GLM
 * billing calendar: route classification, calendar views per family, and the
 * family-specific period boundaries (DeepSeek and GLM peak at different hours).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  FAMILIES,
  FAMILY_IDS,
  GLM_CALENDAR,
  calendarSettingsFor,
  classifySelection,
  defaultFamilyEnabled,
  familyLabel,
  validFamily,
} from '../host/families.js'
import { normalizeSettings, resolvePeriod } from '../host/policy.js'

/** Tuesday 2026-11-03, a plain workday. */
const TUESDAY = (clock) => Date.parse(`2026-11-03T${clock}:00+08:00`)

/** Saturday 2026-11-07. */
const SATURDAY = Date.parse('2026-11-07T15:00:00+08:00')

/** Thursday 2026-10-01, a Chinese statutory holiday falling on a weekday. */
const HOLIDAY_THURSDAY = (clock) => Date.parse(`2026-10-01T${clock}:00+08:00`)

test('the family registry declares DeepSeek and GLM in display order', () => {
  assert.deepEqual(FAMILY_IDS, ['deepseek', 'glm'])
  assert.deepEqual(FAMILIES.map((family) => family.id), ['deepseek', 'glm'])
  assert.deepEqual(FAMILIES.map((family) => family.label), ['DeepSeek', 'GLM'])
})

test('classification prefers model prefixes, then provider routes, then DeepSeek', () => {
  assert.equal(classifySelection('zai-coding-cn', 'glm-5.3'), 'glm')
  assert.equal(classifySelection('anything', 'GLM-4.6'), 'glm', 'model prefix is case-insensitive')
  assert.equal(classifySelection('zai', 'unknown-model'), 'glm', 'GLM provider route wins for unknown models')
  assert.equal(classifySelection('deepseek-account', 'deepseek-flash'), 'deepseek')
  assert.equal(classifySelection('other-provider', 'deepseek-v4-pro'), 'deepseek', 'model prefix beats provider')
  assert.equal(classifySelection('qwen-token-plan', 'qwen3-max'), 'deepseek', 'unrecognized routes fall back to DeepSeek')
  assert.equal(classifySelection(undefined, null), 'deepseek')
  assert.equal(classifySelection(null, undefined), 'deepseek')
})

test('validFamily and familyLabel coerce unknown ids to DeepSeek', () => {
  assert.equal(validFamily('glm'), 'glm')
  assert.equal(validFamily('deepseek'), 'deepseek')
  assert.equal(validFamily('qwen'), 'deepseek')
  assert.equal(validFamily(undefined), 'deepseek')
  assert.equal(familyLabel('glm'), 'GLM')
  assert.equal(familyLabel('deepseek'), 'DeepSeek')
  assert.equal(familyLabel('nope'), 'DeepSeek')
})

test('the GLM calendar follows the official Coding Plan rule', () => {
  assert.equal(GLM_CALENDAR.timeZone, 'Asia/Shanghai')
  assert.deepEqual(
    GLM_CALENDAR.peakWindows.map((window) => ({ weekdays: [...window.weekdays], start: window.start, end: window.end })),
    [{ weekdays: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' }],
  )
  assert.deepEqual(GLM_CALENDAR.holidays, [], 'the published rule has no holiday carve-out')
})

test('calendarSettingsFor returns the persisted calendar for DeepSeek and the built-in for GLM', () => {
  const settings = normalizeSettings({
    timeZone: 'Asia/Tokyo',
    peakWindows: [{ weekdays: [1], start: '10:00', end: '11:00' }],
  })
  const deepseek = calendarSettingsFor('deepseek', settings)
  assert.equal(deepseek.timeZone, 'Asia/Tokyo')
  assert.equal(deepseek.peakWindows.length, 1)
  assert.equal(deepseek.holidays, settings.holidays)
  const glm = calendarSettingsFor('glm', settings)
  assert.equal(glm.timeZone, 'Asia/Shanghai')
  assert.deepEqual(glm.peakWindows, GLM_CALENDAR.peakWindows)
  assert.deepEqual(glm.holidays, [])
  assert.equal(calendarSettingsFor('unknown', settings).timeZone, 'Asia/Tokyo', 'unknown ids resolve like DeepSeek')
})

test('a Tuesday morning is DeepSeek peak but GLM off-peak', () => {
  const settings = normalizeSettings({})
  const at = TUESDAY('10:30')
  assert.equal(resolvePeriod(at, calendarSettingsFor('deepseek', settings)).kind, 'peak')
  assert.equal(resolvePeriod(at, calendarSettingsFor('glm', settings)).kind, 'offpeak')
})

test('a Tuesday afternoon inside 14:00–18:00 is peak for both families', () => {
  const settings = normalizeSettings({})
  const at = TUESDAY('15:00')
  assert.equal(resolvePeriod(at, calendarSettingsFor('deepseek', settings)).kind, 'peak')
  assert.equal(resolvePeriod(at, calendarSettingsFor('glm', settings)).kind, 'peak')
})

test('Saturday is off-peak for both families', () => {
  const settings = normalizeSettings({})
  assert.equal(resolvePeriod(SATURDAY, calendarSettingsFor('deepseek', settings)).kind, 'offpeak')
  assert.equal(resolvePeriod(SATURDAY, calendarSettingsFor('glm', settings)).kind, 'offpeak')
})

test('a statutory holiday is DeepSeek off-peak all day while GLM still peaks 14:00–18:00', () => {
  const settings = normalizeSettings({})
  assert.equal(resolvePeriod(HOLIDAY_THURSDAY('10:00'), calendarSettingsFor('deepseek', settings)).kind, 'offpeak')
  assert.equal(resolvePeriod(HOLIDAY_THURSDAY('10:00'), calendarSettingsFor('glm', settings)).kind, 'offpeak')
  assert.equal(resolvePeriod(HOLIDAY_THURSDAY('15:00'), calendarSettingsFor('deepseek', settings)).kind, 'offpeak')
  assert.equal(resolvePeriod(HOLIDAY_THURSDAY('15:00'), calendarSettingsFor('glm', settings)).kind, 'peak')
})

test('the lunch window separates the calendars: DeepSeek peaks in the morning, GLM only from 14:00', () => {
  const settings = normalizeSettings({})
  // Tuesday 11:59 is still DeepSeek peak (09:00–12:00) but GLM off-peak (its
  // window opens at 14:00); 12:30 is off-peak for both; 14:00 peaks for both.
  assert.equal(resolvePeriod(TUESDAY('11:59'), calendarSettingsFor('glm', settings)).kind, 'offpeak')
  assert.equal(resolvePeriod(TUESDAY('11:59'), calendarSettingsFor('deepseek', settings)).kind, 'peak')
  assert.equal(resolvePeriod(TUESDAY('12:30'), calendarSettingsFor('glm', settings)).kind, 'offpeak')
  assert.equal(resolvePeriod(TUESDAY('12:30'), calendarSettingsFor('deepseek', settings)).kind, 'offpeak')
  assert.equal(resolvePeriod(TUESDAY('14:00'), calendarSettingsFor('glm', settings)).kind, 'peak')
  assert.equal(resolvePeriod(TUESDAY('14:00'), calendarSettingsFor('deepseek', settings)).kind, 'peak')
})

test('defaultFamilyEnabled ships both families on', () => {
  assert.deepEqual(defaultFamilyEnabled(), { deepseek: true, glm: true })
})
