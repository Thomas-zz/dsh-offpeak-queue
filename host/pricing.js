/**
 * Cost estimation for off-peak queue runs.
 *
 * Pure functions only: the official DeepSeek price table (CNY per million
 * tokens, peak list price; off-peak is 50%) plus the per-step formula from
 * CONTRACT-V2 §4. The billing tier of one step is decided by the step's
 * completion moment (`assistant/message` event time), so a run that crosses
 * into a peak window is priced per step.
 *
 * @module @zayn_/dsh-offpeak-queue/host/pricing
 */

import { classifySelection } from './families.js'

/** Built-in price table: CNY per million tokens at peak (full price). */
export const DEFAULT_PRICES = Object.freeze({
  'deepseek-flash': Object.freeze({ cacheHit: 0.04, cacheMiss: 2, output: 8 }),
  'deepseek-v4-pro': Object.freeze({ cacheHit: 0.3, cacheMiss: 9, output: 27 }),
  'deepseek-reasoner': Object.freeze({ cacheHit: 0.04, cacheMiss: 2, output: 8 }),
})

/** Date the built-in official price table was last verified. */
export const DEFAULT_PRICES_VERIFIED_AT = '2026-10-10'

/** Providers whose chat models are priced by this table. */
export const PRICED_PROVIDERS = Object.freeze(['deepseek-account', 'deepseek-official', 'deepseek'])

/**
 * GLM Coding Plan credit coefficients, longest-prefix first.
 *
 * Official formula (verified 2026-11-06,
 * https://docs.bigmodel.cn/cn/coding-plan/overview):
 * `credits = (input×inputCoef + cachedInput×cachedCoef + output×outputCoef)/10000`,
 * halved during off-peak. Historical models are server-side rerouted to
 * GLM-5.3 / GLM-5.3-Flash, so only those two coefficient rows exist.
 */
export const GLM_POINTS_TABLE = Object.freeze([
  Object.freeze({ prefix: 'glm-5.3-flash', input: 2.3, cached: 0.56, output: 8 }),
  Object.freeze({ prefix: 'glm-5.3', input: 6.9, cached: 1.7, output: 24 }),
])

/** Date the built-in GLM credit coefficients were last verified. */
export const GLM_POINTS_VERIFIED_AT = '2026-11-06'

/** Credits divider from the official formula (coefficients are per 10k tokens). */
const GLM_POINTS_DIVISOR = 10_000

/** A price table validation failure with a user-facing Chinese message. */
export class PricingError extends Error {
  /**
   * @param {string} message - user-facing Chinese reason.
   */
  constructor(message) {
    super(message)
    this.name = 'PricingError'
  }
}

/**
 * Whether one provider name participates in DeepSeek pricing.
 *
 * @param {unknown} provider - provider id from a model message source.
 * @returns {boolean} true when priced.
 */
export function isPricedProvider(provider) {
  return typeof provider === 'string' && PRICED_PROVIDERS.includes(provider)
}

/**
 * Validate one price entry.
 *
 * @param {unknown} value - candidate entry.
 * @param {string} label - label for error messages.
 * @returns {{cacheHit: number, cacheMiss: number, output: number}} normalized entry.
 * @throws {PricingError} on invalid input.
 */
function normalizePriceEntry(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PricingError(`${label}必须是对象（cacheHit/cacheMiss/output）`)
  }
  for (const key of Object.keys(value)) {
    if (key !== 'cacheHit' && key !== 'cacheMiss' && key !== 'output') {
      throw new PricingError(`${label}包含未知字段：${key}`)
    }
  }
  const entry = {}
  for (const key of ['cacheHit', 'cacheMiss', 'output']) {
    const price = value[key]
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) {
      throw new PricingError(`${label}的 ${key} 必须是非负数字`)
    }
    entry[key] = price
  }
  return entry
}

/**
 * Validate and merge a price patch over a base table. Unknown models are added;
 * known models are overridden field-by-field payloads replace whole entries.
 *
 * @param {unknown} patch - settings `prices` value (model id → entry).
 * @param {object} [base] - base table to merge over.
 * @returns {object} detached merged table.
 * @throws {PricingError} on invalid input.
 */
export function mergePrices(patch, base = DEFAULT_PRICES) {
  const merged = {}
  for (const [model, entry] of Object.entries(base)) merged[model] = { ...entry }
  if (patch === undefined || patch === null) return merged
  if (typeof patch !== 'object' || Array.isArray(patch)) throw new PricingError('prices 必须是对象')
  for (const [model, entry] of Object.entries(patch)) {
    if (typeof model !== 'string' || model.trim() === '') throw new PricingError('prices 的模型 id 必须是非空字符串')
    merged[model] = normalizePriceEntry(entry, `价格表 ${model} `)
  }
  return merged
}

/**
 * Resolve the price entry for one actual provider/model pair.
 *
 * @param {unknown} provider - provider id from the assistant message source.
 * @param {unknown} model - model id from the assistant message source.
 * @param {object} prices - effective price table.
 * @returns {{cacheHit: number, cacheMiss: number, output: number}|null} entry, or null when unpriced.
 */
export function priceFor(provider, model, prices) {
  if (!isPricedProvider(provider)) return null
  if (typeof model !== 'string') return null
  const entry = prices?.[model]
  if (entry === undefined) return null
  return entry
}

/**
 * Normalize one token usage record for cost math.
 *
 * @param {object|undefined|null} usage - raw `assistant/message` usage.
 * @returns {{inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, reasoningTokens: number}} counts.
 */
export function normalizeUsage(usage) {
  const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
  return {
    inputTokens: count(usage?.inputTokens),
    outputTokens: count(usage?.outputTokens),
    cacheReadTokens: count(usage?.cacheReadTokens),
    cacheWriteTokens: count(usage?.cacheWriteTokens),
    reasoningTokens: count(usage?.reasoningTokens),
  }
}

/**
 * Price one step from measured tokens and its billing tier.
 *
 * Formula (CONTRACT-V2 §4):
 * `inMiss = inputTokens + cacheWriteTokens`, `inHit = cacheReadTokens`,
 * `out = outputTokens`, `costPeak = (inMiss*cacheMiss + inHit*cacheHit + out*output)/1e6`,
 * off-peak steps cost half; `saved` is the half-price discount and `peakExtra`
 * is what a peak step cost above the off-peak half price.
 *
 * @param {{tier: 'peak'|'offpeak', usage: object, provider: unknown, model: unknown, prices: object}} input - step input.
 * @returns {{priced: boolean, cost: number|null, peakCost: number|null, saved: number|null, peakExtra: number|null}} step cost.
 */
export function stepCost(input) {
  const usage = normalizeUsage(input.usage)
  const price = priceFor(input.provider, input.model, input.prices)
  if (price === null) {
    return { priced: false, cost: null, peakCost: null, saved: null, peakExtra: null }
  }
  const inMiss = usage.inputTokens + usage.cacheWriteTokens
  const costPeak = (inMiss * price.cacheMiss + usage.cacheReadTokens * price.cacheHit + usage.outputTokens * price.output) / 1e6
  const cost = input.tier === 'peak' ? costPeak : costPeak * 0.5
  return {
    priced: true,
    cost,
    peakCost: costPeak,
    saved: input.tier === 'peak' ? 0 : costPeak * 0.5,
    peakExtra: cost - costPeak * 0.5,
  }
}

/**
 * Resolve the GLM credit coefficients for one model id (longest prefix wins).
 *
 * @param {unknown} model - provider-owned model id.
 * @returns {{prefix: string, input: number, cached: number, output: number}|null} row, or null when unknown.
 */
export function glmPointsRowFor(model) {
  if (typeof model !== 'string') return null
  const lowered = model.toLowerCase()
  let best = null
  for (const row of GLM_POINTS_TABLE) {
    if (lowered.startsWith(row.prefix) && (best === null || row.prefix.length > best.prefix.length)) best = row
  }
  return best
}

/**
 * Estimate GLM Coding Plan credits for one step from measured tokens.
 *
 * `points` is the credited consumption at the step's tier (half during
 * off-peak); `pointsSaved` is the off-peak discount. Non-GLM families and GLM
 * models without a coefficient row return nulls (tokens are still recorded).
 * MCP-tool credits are out of scope; this is an estimate, not a bill.
 *
 * @param {{tier: 'peak'|'offpeak', usage: object, provider: unknown, model: unknown}} input - step input.
 * @returns {{priced: boolean, points: number|null, pointsSaved: number|null}} step credit estimate.
 */
export function stepPoints(input) {
  if (classifySelection(input.provider, input.model) !== 'glm') {
    return { priced: false, points: null, pointsSaved: null }
  }
  const row = glmPointsRowFor(input.model)
  if (row === null) return { priced: false, points: null, pointsSaved: null }
  const usage = normalizeUsage(input.usage)
  const inMiss = usage.inputTokens + usage.cacheWriteTokens
  const base = (inMiss * row.input + usage.cacheReadTokens * row.cached + usage.outputTokens * row.output) / GLM_POINTS_DIVISOR
  const points = input.tier === 'peak' ? base : base * 0.5
  return {
    priced: true,
    points,
    pointsSaved: input.tier === 'peak' ? 0 : base * 0.5,
  }
}

/**
 * Sum step records into run totals.
 *
 * A run without steps costs 0 and is priced (no tokens were spent); a run whose
 * steps are all unpriced keeps `null` costs with `unpriced: true`. GLM steps
 * carry parallel credit estimates: `points`/`pointsSaved` stay `null` while no
 * step of the run had a known coefficient table (mixed runs sum what they know
 * and flag `pointsPartial`).
 *
 * @param {object[]} steps - priced step records (`cost`, `peakCost`, `saved`, `peakExtra`, `usage`, `points`, `pointsSaved`).
 * @returns {{cost: number|null, peakCost: number|null, saved: number|null, peakExtra: number|null, usage: {inputTokens: number, outputTokens: number, cacheReadTokens: number, reasoningTokens: number, cacheWriteTokens: number}, unpriced: boolean, points: number|null, pointsSaved: number|null, pointsPartial: boolean}} totals.
 */
export function sumRunCost(steps) {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  let pricedSteps = 0
  let unpriced = false
  let cost = 0
  let peakCost = 0
  let saved = 0
  let peakExtra = 0
  let pointSteps = 0
  let points = 0
  let pointsSaved = 0
  for (const step of steps) {
    const stepUsage = step.usage ?? {}
    usage.inputTokens += typeof stepUsage.inputTokens === 'number' ? stepUsage.inputTokens : 0
    usage.outputTokens += typeof stepUsage.outputTokens === 'number' ? stepUsage.outputTokens : 0
    usage.cacheReadTokens += typeof stepUsage.cacheReadTokens === 'number' ? stepUsage.cacheReadTokens : 0
    usage.cacheWriteTokens += typeof stepUsage.cacheWriteTokens === 'number' ? stepUsage.cacheWriteTokens : 0
    usage.reasoningTokens += typeof stepUsage.reasoningTokens === 'number' ? stepUsage.reasoningTokens : 0
    if (typeof step.cost === 'number') {
      pricedSteps += 1
      cost += step.cost
      peakCost += typeof step.peakCost === 'number' ? step.peakCost : 0
      saved += typeof step.saved === 'number' ? step.saved : 0
      peakExtra += typeof step.peakExtra === 'number' ? step.peakExtra : 0
    } else {
      unpriced = true
    }
    if (typeof step.points === 'number') {
      pointSteps += 1
      points += step.points
      pointsSaved += typeof step.pointsSaved === 'number' ? step.pointsSaved : 0
    }
  }
  if (steps.length > 0 && pricedSteps === 0) {
    return {
      cost: null,
      peakCost: null,
      saved: null,
      peakExtra: null,
      usage,
      unpriced: true,
      points: steps.length > 0 && pointSteps > 0 ? points : null,
      pointsSaved: pointSteps > 0 ? pointsSaved : null,
      pointsPartial: pointSteps > 0 && pointSteps < steps.length,
    }
  }
  return {
    cost,
    peakCost,
    saved,
    peakExtra,
    usage,
    unpriced,
    points: pointSteps > 0 ? points : null,
    pointsSaved: pointSteps > 0 ? pointsSaved : null,
    pointsPartial: pointSteps > 0 && pointSteps < steps.length,
  }
}
