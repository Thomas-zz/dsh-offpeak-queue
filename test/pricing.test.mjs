/**
 * Unit tests for the cost model in `host/pricing.js`: price table validation,
 * provider gating, per-step tier pricing, and run totals (including a
 * cross-peak split where the billing tier changes between steps).
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_PRICES,
  DEFAULT_PRICES_VERIFIED_AT,
  GLM_POINTS_VERIFIED_AT,
  PricingError,
  glmPointsRowFor,
  isPricedProvider,
  mergePrices,
  normalizeUsage,
  priceFor,
  stepCost,
  stepPoints,
  sumRunCost,
} from '../host/pricing.js'
import { normalizeSettings, resolvePeriod } from '../host/policy.js'

/** Default normalized settings (Asia/Shanghai peak rule). */
const settings = normalizeSettings({})

/**
 * Price one step at one instant using the real billing calendar.
 *
 * @param {number} at - step completion epoch ms.
 * @param {object} usage - raw token usage.
 * @param {object} [options] - provider/model/prices overrides.
 * @returns {object} step cost plus tier.
 */
function costAt(at, usage, options = {}) {
  const tier = resolvePeriod(at, settings).kind
  const cost = stepCost({
    tier,
    usage,
    provider: options.provider ?? 'deepseek-account',
    model: options.model ?? 'deepseek-flash',
    prices: options.prices ?? settings.prices,
  })
  return { tier, ...cost, usage: normalizeUsage(usage) }
}

test('built-in price table carries the official peak prices', () => {
  assert.deepEqual(DEFAULT_PRICES['deepseek-flash'], { cacheHit: 0.04, cacheMiss: 2, output: 8 })
  assert.deepEqual(DEFAULT_PRICES['deepseek-v4-pro'], { cacheHit: 0.3, cacheMiss: 9, output: 27 })
  assert.equal(DEFAULT_PRICES_VERIFIED_AT, '2026-10-10')
})

test('only DeepSeek providers are priced, by provider and model', () => {
  for (const provider of ['deepseek-account', 'deepseek-official', 'deepseek']) assert.equal(isPricedProvider(provider), true)
  assert.equal(isPricedProvider('openai'), false)
  assert.equal(isPricedProvider(undefined), false)
  assert.deepEqual(priceFor('deepseek-account', 'deepseek-flash', DEFAULT_PRICES), { cacheHit: 0.04, cacheMiss: 2, output: 8 })
  assert.equal(priceFor('openai', 'deepseek-flash', DEFAULT_PRICES), null, 'unknown provider is unpriced')
  assert.equal(priceFor('deepseek-account', 'unknown-model', DEFAULT_PRICES), null, 'unknown model is unpriced')
})

test('mergePrices overrides, adds entries, and validates input', () => {
  const merged = mergePrices({ 'deepseek-flash': { cacheHit: 0.02, cacheMiss: 1, output: 4 }, 'my-model': { cacheHit: 1, cacheMiss: 2, output: 3 } })
  assert.deepEqual(merged['deepseek-flash'], { cacheHit: 0.02, cacheMiss: 1, output: 4 })
  assert.deepEqual(merged['my-model'], { cacheHit: 1, cacheMiss: 2, output: 3 })
  assert.deepEqual(merged['deepseek-v4-pro'], { cacheHit: 0.3, cacheMiss: 9, output: 27 }, 'base entries are kept')
  assert.throws(() => mergePrices('nope'), PricingError)
  assert.throws(() => mergePrices({ x: { cacheHit: -1, cacheMiss: 1, output: 1 } }), /非负数字/)
  assert.throws(() => mergePrices({ x: { cacheHit: 1, cacheMiss: 1 } }), /output/)
  assert.throws(() => mergePrices({ x: { cacheHit: 1, cacheMiss: 1, output: 1, extra: 2 } }), /未知字段/)
  assert.throws(() => mergePrices({ '': { cacheHit: 1, cacheMiss: 1, output: 1 } }), /非空字符串/)
})

test('normalizeUsage fills missing counters with zeros', () => {
  assert.deepEqual(normalizeUsage(undefined), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
  assert.deepEqual(normalizeUsage({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 1 }), {
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    reasoningTokens: 1,
  })
})

test('one step is billed at the completion instant tier (off-peak = 50%)', () => {
  // Tuesday 2026-11-03 13:00 Beijing is off-peak; 10:00 is peak.
  const usage = { inputTokens: 1000, cacheWriteTokens: 500, cacheReadTokens: 2000, outputTokens: 400 }
  const peak = costAt(Date.parse('2026-11-03T10:00:00+08:00'), usage)
  const offpeak = costAt(Date.parse('2026-11-03T13:00:00+08:00'), usage)

  // costPeak = (1000+500)*2 + 2000*0.04 + 400*8 = 3000 + 80 + 3200 = 6280 => ¥0.00628
  assert.equal(peak.tier, 'peak')
  assert.equal(peak.priced, true)
  assert.equal(peak.peakCost, 0.00628)
  assert.equal(peak.cost, 0.00628)
  assert.equal(peak.saved, 0)
  assert.equal(peak.peakExtra, 0.00314, 'peak steps pay half the peak price extra')

  assert.equal(offpeak.tier, 'offpeak')
  assert.equal(offpeak.peakCost, 0.00628)
  assert.equal(offpeak.cost, 0.00314)
  assert.equal(offpeak.saved, 0.00314)
  assert.equal(offpeak.peakExtra, 0, 'off-peak steps carry no peak extra')
})

test('unpriced provider/model yields null costs while keeping usage', () => {
  const usage = { inputTokens: 100, outputTokens: 10 }
  const other = costAt(Date.parse('2026-11-03T13:00:00+08:00'), usage, { provider: 'openai' })
  assert.equal(other.priced, false)
  assert.equal(other.cost, null)
  assert.equal(other.peakCost, null)
  assert.equal(other.saved, null)
  assert.equal(other.peakExtra, null)
  assert.equal(other.usage.inputTokens, 100)
})

test('sumRunCost totals steps, keeps usage, and flags unpriced runs', () => {
  const offpeak = costAt(Date.parse('2026-11-03T13:00:00+08:00'), { inputTokens: 1000, outputTokens: 100 })
  const peak = costAt(Date.parse('2026-11-03T10:00:00+08:00'), { inputTokens: 500, outputTokens: 50 })
  const totals = sumRunCost([offpeak, peak])
  assert.equal(totals.cost, offpeak.cost + peak.cost, 'actual cost sums per-step costs')
  assert.equal(totals.peakCost, offpeak.peakCost + peak.peakCost)
  assert.equal(totals.saved, offpeak.saved)
  assert.equal(totals.peakExtra, peak.peakExtra)
  assert.equal(totals.usage.inputTokens, 1500)
  assert.equal(totals.usage.outputTokens, 150)
  assert.equal(totals.unpriced, false)

  const empty = sumRunCost([])
  assert.deepEqual(empty, {
    cost: 0,
    peakCost: 0,
    saved: 0,
    peakExtra: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    points: null,
    pointsSaved: null,
    pointsPartial: false,
    unpriced: false,
  })

  const unpriced = sumRunCost([costAt(Date.parse('2026-11-03T13:00:00+08:00'), { inputTokens: 1 }, { provider: 'openai' })])
  assert.equal(unpriced.cost, null)
  assert.equal(unpriced.peakCost, null)
  assert.equal(unpriced.unpriced, true)
  assert.equal(unpriced.usage.inputTokens, 1, 'tokens are still recorded')
})

test('a run crossing into peak splits cost/saved/peakExtra per step', () => {
  // Custom window: Tuesday (ISO 2) 14:00-18:00. Steps complete at 13:59
  // (off-peak) and 14:00 (peak) — the exact half-open boundary.
  const custom = normalizeSettings({ peakWindows: [{ weekdays: [2], start: '14:00', end: '18:00' }] }, settings)
  const usage = { inputTokens: 1000, cacheReadTokens: 0, outputTokens: 100 }
  const stepBefore = (() => {
    const at = Date.parse('2026-11-03T13:59:00+08:00')
    const tier = resolvePeriod(at, custom).kind
    const cost = stepCost({ tier, usage, provider: 'deepseek-account', model: 'deepseek-flash', prices: custom.prices })
    return { tier, ...cost, usage: normalizeUsage(usage) }
  })()
  const stepAfter = (() => {
    const at = Date.parse('2026-11-03T14:00:00+08:00')
    const tier = resolvePeriod(at, custom).kind
    const cost = stepCost({ tier, usage, provider: 'deepseek-account', model: 'deepseek-flash', prices: custom.prices })
    return { tier, ...cost, usage: normalizeUsage(usage) }
  })()
  assert.equal(stepBefore.tier, 'offpeak')
  assert.equal(stepAfter.tier, 'peak')

  const totals = sumRunCost([stepBefore, stepAfter])
  // costPeak per step = (1000*2 + 100*8)/1e6 = 0.0028
  assert.equal(stepBefore.peakCost, 0.0028)
  assert.equal(stepBefore.cost, 0.0014)
  assert.equal(stepAfter.cost, 0.0028)
  assert.equal(totals.cost, 0.0042)
  assert.equal(totals.peakCost, 0.0056)
  assert.equal(totals.saved, 0.0014)
  assert.equal(totals.peakExtra, 0.0014)
  assert.equal(Math.round(totals.cost * 1e6) / 1e6, 0.0042, 'cross-peak actual cost matches the formula')
})

// ────────────────────────────────────────────────────────────────────────────
// GLM Coding Plan credit estimation
// ────────────────────────────────────────────────────────────────────────────

test('glmPointsRowFor matches the longest model prefix', () => {
  assert.equal(glmPointsRowFor('glm-5.3').input, 6.9)
  assert.equal(glmPointsRowFor('GLM-5.3-Flash').input, 2.3, 'flash wins over the shorter glm-5.3 prefix')
  assert.equal(glmPointsRowFor('glm-5.3-flashx').input, 2.3)
  assert.equal(glmPointsRowFor('glm-4.6'), null, 'historical models outside the published table are unpriced')
  assert.equal(glmPointsRowFor('deepseek-flash'), null)
  assert.equal(glmPointsRowFor(undefined), null)
  assert.equal(typeof GLM_POINTS_VERIFIED_AT, 'string')
})

test('stepPoints estimates GLM credits with the off-peak half discount', () => {
  const usage = { inputTokens: 10000, cacheReadTokens: 5000, outputTokens: 2000 }
  // glm-5.3: (10000*6.9 + 5000*1.7 + 2000*24)/10000 = 12.55 base credits.
  const peak = stepPoints({ tier: 'peak', usage, provider: 'zai-coding-cn', model: 'glm-5.3' })
  assert.equal(peak.priced, true)
  assert.equal(peak.points, 12.55)
  assert.equal(peak.pointsSaved, 0)
  const offpeak = stepPoints({ tier: 'offpeak', usage, provider: 'zai', model: 'glm-5.3' })
  assert.equal(offpeak.points, 12.55 * 0.5)
  assert.equal(offpeak.pointsSaved, 12.55 * 0.5)
})

test('stepPoints uses the flash coefficients and cache reads at the cached rate', () => {
  const usage = { inputTokens: 1000, cacheReadTokens: 1000, outputTokens: 1000 }
  // glm-5.3-flash: (1000*2.3 + 1000*0.56 + 1000*8)/10000 = 1.086 base credits.
  const result = stepPoints({ tier: 'peak', usage, provider: 'zai', model: 'glm-5.3-flash' })
  assert.equal(result.points, 1.086)
})

test('stepPoints stays null for non-GLM families and unknown GLM models', () => {
  const deepseek = stepPoints({ tier: 'peak', usage: { inputTokens: 1 }, provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.deepEqual(deepseek, { priced: false, points: null, pointsSaved: null })
  const unknown = stepPoints({ tier: 'offpeak', usage: { inputTokens: 1 }, provider: 'zai', model: 'glm-9' })
  assert.deepEqual(unknown, { priced: false, points: null, pointsSaved: null })
})

test('sumRunCost folds GLM credits alongside CNY and flags partial runs', () => {
  const glmOffpeak = { usage: normalizeUsage({ inputTokens: 10000 }), cost: null, points: 5, pointsSaved: 5 }
  const glmPeak = { usage: normalizeUsage({ inputTokens: 1000 }), cost: null, points: 10, pointsSaved: 0 }
  const mixed = sumRunCost([glmOffpeak, glmPeak])
  assert.equal(mixed.cost, null)
  assert.equal(mixed.unpriced, true)
  assert.equal(mixed.points, 15)
  assert.equal(mixed.pointsSaved, 5)
  assert.equal(mixed.pointsPartial, false)

  const partial = sumRunCost([glmOffpeak, { usage: normalizeUsage({ inputTokens: 1 }), cost: null, points: null }])
  assert.equal(partial.points, 5)
  assert.equal(partial.pointsPartial, true)

  const none = sumRunCost([{ usage: normalizeUsage({ inputTokens: 1 }), cost: null }])
  assert.equal(none.points, null)
  assert.equal(none.pointsSaved, null)
  assert.equal(none.pointsPartial, false)
})
