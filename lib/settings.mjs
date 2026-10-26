// @ts-check
// Settings come from two places: the plugin's block in config/plugins.yml
// (ctx.settings: spend switch, ceiling, per-board Actor and limits) and the
// portals.yml job_boards entry (the search itself). Result counts are clamped
// to a hard ceiling whatever either file says.

import { BOARDS, BOARD_IDS } from './boards.mjs';

export const HARD_MAX_RESULTS = 50;
export const DEFAULT_RESULTS = 25;
export const DEFAULT_MAX_USD = 1;
const DEFAULT_TIMEOUT_SECS = 300;

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** An integer in [1, HARD_MAX_RESULTS]; notes in `warnings` when it clamps. */
function clampResults(value, fallback, label, warnings) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) {
    warnings.push(`${label} ${JSON.stringify(value)} is not a number; using ${fallback}`);
    return fallback;
  }
  if (n > HARD_MAX_RESULTS) {
    warnings.push(`${label} ${n} is above the ceiling of ${HARD_MAX_RESULTS}; using ${HARD_MAX_RESULTS}`);
    return HARD_MAX_RESULTS;
  }
  return Math.max(1, n);
}

/**
 * @param {any} settings ctx.settings
 * @param {any} entry the portals.yml entry
 */
export function readSettings(settings, entry) {
  const s = isPlainObject(settings) ? settings : {};
  const e = isPlainObject(entry) ? entry : {};
  const warnings = [];

  const query = typeof e.query === 'string' ? e.query.trim() : '';
  if (!query) throw new Error(`entry "${e.name || '?'}" needs a query, e.g. query: "data engineer"`);
  const search = {
    query,
    location: typeof e.location === 'string' ? e.location.trim() : '',
    country: typeof e.country === 'string' && /^[A-Za-z]{2}$/.test(e.country.trim()) ? e.country.trim() : '',
  };

  let only = null;
  if (e.boards !== undefined) {
    if (!Array.isArray(e.boards)) throw new Error('entry boards must be a list, e.g. [linkedin, indeed]');
    only = e.boards.map(String);
    const unknown = only.filter((b) => !BOARD_IDS.includes(b));
    if (unknown.length) throw new Error(`unknown board(s) ${unknown.join(', ')}; known: ${BOARD_IDS.join(', ')}`);
  }

  const defaultCap = clampResults(e.max_results ?? s.max_results, DEFAULT_RESULTS, 'max_results', warnings);
  const boardsCfg = isPlainObject(s.boards) ? s.boards : {};
  const boards = [];
  for (const id of BOARD_IDS) {
    const cfg = isPlainObject(boardsCfg[id]) ? boardsCfg[id] : {};
    if (cfg.enabled === false) continue;
    if (only && !only.includes(id)) continue;
    // A board that is off by default runs when plugins.yml turns it on or the
    // entry names it in boards.
    if (!BOARDS[id].defaultEnabled && cfg.enabled !== true && !only) continue;
    // A per-board max_results in plugins.yml is a ceiling for that board.
    const boardCap = clampResults(cfg.max_results, HARD_MAX_RESULTS, `boards.${id}.max_results`, warnings);
    boards.push({
      id,
      def: BOARDS[id],
      actor: typeof cfg.actor === 'string' && cfg.actor.trim() ? cfg.actor.trim() : BOARDS[id].actor,
      cap: Math.min(defaultCap, boardCap),
      extra: isPlainObject(cfg.input) ? { ...cfg.input } : {},
    });
  }

  const maxUsdRaw = Number(s.max_usd);
  const maxUsd = s.max_usd !== undefined && Number.isFinite(maxUsdRaw) && maxUsdRaw >= 0 ? maxUsdRaw : DEFAULT_MAX_USD;
  const timeoutRaw = Math.floor(Number(s.timeout_secs));
  const timeoutSecs = Number.isFinite(timeoutRaw) ? Math.min(900, Math.max(60, timeoutRaw)) : DEFAULT_TIMEOUT_SECS;

  return {
    search,
    boards,
    confirmSpend: s.confirm_spend === true,
    maxUsd,
    timeoutSecs,
    warnings,
  };
}
