/**
 * Model-family registry for the off-peak queue.
 *
 * A "family" is a billing world: one calendar of peak windows plus (optionally)
 * a price/points table. The plugin ships two built-in families — DeepSeek (the
 * original rule, calendar follows the persisted settings) and GLM (Coding Plan
 * rule, calendar hard-coded from the official docs) — and every other provider
 * falls back to the DeepSeek calendar so existing behaviour never changes.
 *
 * Family facts (verified 2026-11-06):
 * - DeepSeek: peak = Mon–Fri (excl. Chinese statutory holidays) 09:00–12:00
 *   and 14:00–18:00 Beijing time; off-peak is half price.
 * - GLM Coding Plan (https://docs.bigmodel.cn/cn/coding-plan/overview):
 *   off-peak calls consume 50% of the base credits; peak = Mon–Fri
 *   14:00–18:00 UTC+8. The published rule has no holiday carve-out.
 *
 * @module dsh-offpeak-queue/host/families
 */

/** Built-in family ids, display order. */
export const FAMILY_IDS = Object.freeze(['deepseek', 'glm'])

/**
 * Display metadata for the built-in families. Labels are brand names and read
 * the same in every locale.
 */
export const FAMILIES = Object.freeze([
  Object.freeze({ id: 'deepseek', label: 'DeepSeek' }),
  Object.freeze({ id: 'glm', label: 'GLM' }),
])

/**
 * GLM Coding Plan billing calendar: peak every Monday–Friday 14:00–18:00
 * (UTC+8), no holiday exception (the official rule does not publish one).
 */
export const GLM_CALENDAR = Object.freeze({
  timeZone: 'Asia/Shanghai',
  peakWindows: Object.freeze([
    Object.freeze({ weekdays: Object.freeze([1, 2, 3, 4, 5]), start: '14:00', end: '18:00' }),
  ]),
  holidays: Object.freeze([]),
  holidayYears: Object.freeze([]),
})

/** DeepSeek provider routes participating in the DeepSeek family. */
const DEEPSEEK_PROVIDERS = new Set(['deepseek-account', 'deepseek-official', 'deepseek'])

/** GLM provider routes (pi-ai catalog ids for the Z.AI / bigmodel coding endpoints). */
const GLM_PROVIDERS = new Set(['zai', 'zai-coding-cn'])

/**
 * Whether a model id belongs to one family by prefix (case-insensitive).
 *
 * @param {unknown} model - provider-owned model id.
 * @param {string} prefix - family prefix (`glm`, `deepseek`).
 * @returns {boolean} prefix match.
 */
function modelHasPrefix(model, prefix) {
  return typeof model === 'string' && model.toLowerCase().startsWith(prefix)
}

/**
 * Classify one provider/model route into a billing family.
 *
 * Model-id prefixes win over provider names (a custom provider route that
 * serves `glm-*` models is still GLM); anything unrecognised falls back to the
 * DeepSeek family so the queue keeps its historical behaviour for other models.
 *
 * @param {unknown} provider - provider id from a model selection / message source.
 * @param {unknown} model - provider-owned model id.
 * @returns {'deepseek'|'glm'} family id.
 */
export function classifySelection(provider, model) {
  if (modelHasPrefix(model, 'glm')) return 'glm'
  if (modelHasPrefix(model, 'deepseek')) return 'deepseek'
  if (typeof provider === 'string') {
    if (GLM_PROVIDERS.has(provider)) return 'glm'
    if (DEEPSEEK_PROVIDERS.has(provider)) return 'deepseek'
  }
  return 'deepseek'
}

/**
 * Coerce a stored/configured family value into a valid id.
 *
 * @param {unknown} familyId - candidate family id.
 * @returns {'deepseek'|'glm'} valid family id (DeepSeek for anything unknown).
 */
export function validFamily(familyId) {
  return familyId === 'glm' ? 'glm' : 'deepseek'
}

/**
 * Family display label.
 *
 * @param {unknown} familyId - family id.
 * @returns {string} brand label, `DeepSeek` when unknown.
 */
export function familyLabel(familyId) {
  return familyId === 'glm' ? 'GLM' : 'DeepSeek'
}

/**
 * Calendar-settings view for one family, shaped exactly like a normalized
 * settings object so `resolvePeriod`/`nextOffpeakStart` accept it directly.
 *
 * The DeepSeek family follows the persisted (user-overridable) calendar; the
 * GLM family always uses the built-in official rule.
 *
 * @param {unknown} familyId - family id.
 * @param {object} settings - normalized queue settings.
 * @returns {object} calendar settings (DeepSeek view for unknown ids).
 */
export function calendarSettingsFor(familyId, settings) {
  if (familyId === 'glm') {
    return {
      timeZone: GLM_CALENDAR.timeZone,
      peakWindows: GLM_CALENDAR.peakWindows,
      holidays: GLM_CALENDAR.holidays,
      holidayYears: GLM_CALENDAR.holidayYears,
    }
  }
  return {
    timeZone: settings.timeZone,
    peakWindows: settings.peakWindows,
    holidays: settings.holidays,
    holidayYears: settings.holidayYears,
  }
}

/**
 * Default per-family enable switches (both families on).
 *
 * @returns {{deepseek: boolean, glm: boolean}} fresh default toggles.
 */
export function defaultFamilyEnabled() {
  return { deepseek: true, glm: true }
}
