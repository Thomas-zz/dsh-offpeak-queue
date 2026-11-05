/**
 * Cost estimation for off-peak queue runs.
 *
 * Pure functions only: the official DeepSeek price table (CNY per million
 * tokens, peak list price; off-peak is 50%) plus the per-step formula from
 * CONTRACT-V2 §4. The billing tier of one step is decided by the step's
 * completion moment (`assistant/message` event time), so a run that crosses
 * into a peak window is priced per step.
 *
 * @module dsh-offpeak-queue/host/pricing
 */

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
 * Sum step records into run totals.
 *
 * A run without steps costs 0 and is priced (no tokens were spent); a run whose
 * steps are all unpriced keeps `null` costs with `unpriced: true`.
 *
 * @param {object[]} steps - priced step records (`cost`, `peakCost`, `saved`, `peakExtra`, `usage`).
 * @returns {{cost: number|null, peakCost: number|null, saved: number|null, peakExtra: number|null, usage: {inputTokens: number, outputTokens: number, cacheReadTokens: number, reasoningTokens: number, cacheWriteTokens: number}, unpriced: boolean}} totals.
 */
export function sumRunCost(steps) {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  let pricedSteps = 0
  let unpriced = false
  let cost = 0
  let peakCost = 0
  let saved = 0
  let peakExtra = 0
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
  }
  if (steps.length > 0 && pricedSteps === 0) {
    return { cost: null, peakCost: null, saved: null, peakExtra: null, usage, unpriced: true }
  }
  return { cost, peakCost, saved, peakExtra, usage, unpriced }
}
