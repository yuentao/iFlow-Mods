/**
 * context-window-loader.cjs
 *
 * Makes iFlow's footer "上下文剩余 xx%" honor the tokensLimit field from
 * iFlow's own settings.json (~/.iflow/settings.json).
 *
 * Problem solved:
 *   The footer computes the percentage as (1 - promptTokens / JR(model)).
 *   JR(model, settingsLimit) uses the settings.json tokensLimit only when its
 *   caller passes it as the second argument. The compression call sites do,
 *   but the footer call site (L6217) does NOT — so the display always falls
 *   back to the hardcoded window table (128000 for unknown models), showing
 *   "上下文剩余 0%" for large-context models or an over-optimistic percentage
 *   for small-window models, and never reacting to the user's tokensLimit.
 *
 * Strategy:
 *   The patched JR() calls readTokensLimit() right after its builtin
 *   `if (e && e > 0) return e` check. When the caller already supplied a
 *   positive limit, nothing changes; otherwise the settings.json tokensLimit
 *   is used before falling back to the hardcoded table. Result: the footer
 *   and the compression logic read the very same value and stay consistent.
 *
 * Caching:
 *   JR() runs on every footer render, so the settings file is read at most
 *   once per TTL window (5s) and only re-parsed when its mtime changed.
 *   Editing settings.json takes effect within seconds, no restart needed.
 *
 * Zero side effects: if settings.json is missing, unreadable, or has no
 * positive tokensLimit, readTokensLimit() returns 0 and JR() behaves exactly
 * as the original code.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Mirror iFlow's own settings directory resolution: IFLOW_HOME wins,
 * otherwise ~/.iflow (see Tn() in iflow.js).
 */
const SETTINGS_PATH = process.env.IFLOW_HOME
  ? path.join(process.env.IFLOW_HOME, 'settings.json')
  : path.join(os.homedir(), '.iflow', 'settings.json');

const TTL_MS = 5000;

let cachedLimit = 0;
let lastCheckAt = 0;
let lastMtimeMs = 0;

function readFileTokensLimit() {
  try {
    const stat = fs.statSync(SETTINGS_PATH);
    if (stat.mtimeMs === lastMtimeMs) return cachedLimit;
    lastMtimeMs = stat.mtimeMs;
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    const value = parsed && typeof parsed === 'object' ? parsed.tokensLimit : 0;
    const n = typeof value === 'string' ? Number.parseInt(value, 10) : value;
    cachedLimit = typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    cachedLimit = 0;
    lastMtimeMs = 0;
  }
  return cachedLimit;
}

/**
 * Read tokensLimit from settings.json with TTL + mtime caching.
 * @returns {number} positive token limit, or 0 when not configured
 */
function readTokensLimit() {
  const now = Date.now();
  if (now - lastCheckAt < TTL_MS) return cachedLimit;
  lastCheckAt = now;
  return readFileTokensLimit();
}

module.exports = { readTokensLimit };