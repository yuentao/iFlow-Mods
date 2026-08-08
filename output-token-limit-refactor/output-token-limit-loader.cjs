/**
 * output-token-limit-loader.cjs
 *
 * Loads output token limit configuration from ~/.iflow/output-token-limits.json
 * and patches the Dqe (A2) adapter instance.
 *
 * Problem solved:
 *   iFlow hardcodes per-model output token caps in MOt() (L880): unknown models
 *   fall back to 8000, qwen3 defaults to 8192, deepseek-v3 to 8192, etc. The
 *   computed cap is written to requestBody.max_new_tokens (and max_tokens for
 *   kimi-k2.5/deepseek) AFTER A2.configureThinkingRequest/configureNonThinkingRequest
 *   run. When the model's reply exceeds the cap, the API truncates the response
 *   and iFlow shows "⚠️ 因 token 限制而截断响应。"
 *
 * Strategy:
 *   Monkey-patch A2.configureThinkingRequest / configureNonThinkingRequest.
 *   Inside the patch, install a getter/setter pair on requestBody for
 *   'max_new_tokens' and 'max_tokens' via Object.defineProperty. The later
 *   assignment `p.max_new_tokens = A` is swallowed by the setter, and every
 *   read (JSON.stringify for the fetch body and telemetry) returns the
 *   configured limit instead. This intercepts the cap INSIDE
 *   generateContentInternal without modifying the source beyond L950.
 *
 * Modes:
 *   - "floor"    (default): effective value = max(configuredLimit, builtinValue).
 *                Only raises the cap, never lowers iFlow's builtin table values.
 *   - "override": effective value = configuredLimit, always wins.
 *
 * Priority chain (resolveLimit):
 *   1. modelLimits[] first matching rule (regex, case-insensitive) → its limit
 *   2. defaultLimit (global fallback)
 *   3. 0 / missing → no hijack, iFlow builtin MOt() behavior preserved
 *
 * Compatible with thinking-mode-refactor, streaming-mode-refactor and
 * kimi-request-override-refactor (same insertion point L950; all monkey-patch
 * the same two configure methods without touching each other's logic).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const LOG_PREFIX = '[OutputTokenLimit]';
const CONFIG_PATH = path.join(os.homedir(), '.iflow', 'output-token-limits.json');

/**
 * Request body fields whose assignment must be intercepted.
 * iFlow writes the MOt() result into max_new_tokens for every model, and into
 * max_tokens for kimi-k2.5 / deepseek / aone-mode requests.
 */
const TARGET_FIELDS = ['max_new_tokens', 'max_tokens'];

/**
 * Default configuration — used when user config file is missing or invalid.
 * defaultLimit 32768 raises the builtin 8000/8192 fallbacks to a level most
 * modern models support, while "floor" mode keeps higher builtin values
 * (e.g. gemini 65536) untouched.
 */
const DEFAULT_CONFIG = {
  version: '1.0.0',
  mode: 'floor',
  defaultLimit: 32768,
  modelLimits: []
};

/**
 * Coerce a raw value into a positive integer limit, or 0 when invalid.
 */
function sanitizeLimit(value) {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/**
 * Load user configuration from ~/.iflow/output-token-limits.json.
 * Falls back to DEFAULT_CONFIG on missing/invalid file.
 */
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const userConfig = JSON.parse(raw);
    if (!userConfig || typeof userConfig !== 'object') return { ...DEFAULT_CONFIG };
    return normalizeConfig(userConfig);
  } catch (e) {
    console.warn(`${LOG_PREFIX} Config load failed, using defaults: ${e.message}`);
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Merge user config over defaults and validate every field.
 */
function normalizeConfig(userConfig) {
  const merged = { ...DEFAULT_CONFIG, ...userConfig };
  if (merged.mode !== 'override' && merged.mode !== 'floor') {
    if (userConfig && userConfig.mode !== undefined) {
      console.warn(`${LOG_PREFIX} Unknown mode "${userConfig.mode}", falling back to "floor"`);
    }
    merged.mode = 'floor';
  }
  merged.defaultLimit = sanitizeLimit(merged.defaultLimit);
  if (!Array.isArray(merged.modelLimits)) merged.modelLimits = [];
  merged.modelLimits = merged.modelLimits.filter((rule) => {
    if (!rule || typeof rule.pattern !== 'string' || rule.pattern.length === 0) return false;
    const limit = sanitizeLimit(rule.limit);
    if (limit <= 0) return false;
    rule.limit = limit;
    return true;
  });
  return merged;
}

/**
 * Resolve the configured output token limit for a model.
 * @param {string} modelName
 * @param {object} config
 * @returns {number} positive limit, or 0 when the request should be left untouched
 */
function resolveLimit(modelName, config) {
  if (modelName && typeof modelName === 'string') {
    const name = modelName.toLowerCase();
    for (const rule of config.modelLimits) {
      try {
        if (new RegExp(rule.pattern, 'i').test(name)) return rule.limit;
      } catch (e) {
        console.warn(`${LOG_PREFIX} Invalid regex pattern "${rule.pattern}": ${e.message}`);
        if (name.includes(rule.pattern.toLowerCase())) return rule.limit;
      }
    }
  }
  return config.defaultLimit;
}

/**
 * Intercept writes to a request body field so the final serialized value is
 * governed by the configured limit instead of iFlow's builtin MOt() result.
 *
 * The setter records whatever iFlow assigns (the builtin cap); the getter
 * applies the mode: "override" always returns the configured limit, "floor"
 * returns the larger of the builtin cap and the configured limit.
 */
function hijackField(requestBody, field, limit, mode) {
  let current = requestBody[field];
  Object.defineProperty(requestBody, field, {
    configurable: true,
    enumerable: true,
    get() {
      if (mode === 'override') return limit;
      return typeof current === 'number' && current > limit ? current : limit;
    },
    set(value) {
      current = value;
    }
  });
}

/**
 * Apply the configured limit to a request body, when one resolves.
 */
function applyOutputTokenLimit(config, modelName, requestBody) {
  const limit = resolveLimit(modelName, config);
  if (limit <= 0) return;
  if (!requestBody || typeof requestBody !== 'object') return;
  for (const field of TARGET_FIELDS) {
    try {
      hijackField(requestBody, field, limit, config.mode);
    } catch (e) {
      console.warn(`${LOG_PREFIX} Failed to hijack "${field}": ${e.message}`);
    }
  }
}

/**
 * Main load function — patches the Dqe (A2) adapter instance.
 * @param {object} adapter - Dqe instance (A2)
 */
function load(adapter) {
  const config = loadConfig();

  if (!adapter || typeof adapter !== 'object') {
    console.warn(`${LOG_PREFIX} Invalid adapter, skipping setup`);
    return;
  }

  adapter._outputTokenLimitConfig = config;

  adapter.resolveOutputTokenLimit = function (modelName) {
    return resolveLimit(modelName, this._outputTokenLimitConfig);
  };

  // Monkey-patch A2.configureThinkingRequest
  const originalConfigureThinkingRequest = adapter.configureThinkingRequest;
  if (typeof originalConfigureThinkingRequest === 'function') {
    adapter.configureThinkingRequest = function (modelName, requestBody, thinkingConfig) {
      const result = originalConfigureThinkingRequest.call(this, modelName, requestBody, thinkingConfig);
      applyOutputTokenLimit(this._outputTokenLimitConfig, modelName, requestBody);
      return result;
    };
  }

  // Monkey-patch A2.configureNonThinkingRequest
  const originalConfigureNonThinkingRequest = adapter.configureNonThinkingRequest;
  if (typeof originalConfigureNonThinkingRequest === 'function') {
    adapter.configureNonThinkingRequest = function (modelName, requestBody) {
      const result = originalConfigureNonThinkingRequest.call(this, modelName, requestBody);
      applyOutputTokenLimit(this._outputTokenLimitConfig, modelName, requestBody);
      return result;
    };
  }

  adapter.getOutputTokenLimitConfig = function () {
    return this._outputTokenLimitConfig;
  };

  adapter.updateOutputTokenLimitConfig = function (newConfig) {
    this._outputTokenLimitConfig = normalizeConfig({ ...this._outputTokenLimitConfig, ...newConfig });
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this._outputTokenLimitConfig, null, 2), 'utf-8');
    } catch (e) {
      console.warn(`${LOG_PREFIX} Config save failed: ${e.message}`);
    }
    return true;
  };

  adapter.reloadOutputTokenLimitConfig = function () {
    this._outputTokenLimitConfig = loadConfig();
    return this._outputTokenLimitConfig;
  };

  console.log(`${LOG_PREFIX} mode: ${config.mode}, defaultLimit: ${config.defaultLimit}, modelLimits: ${config.modelLimits.length} rules`);
  console.log(`${LOG_PREFIX} Patched configureThinkingRequest and configureNonThinkingRequest`);

  return adapter;
}

module.exports = { load, loadConfig, resolveLimit, DEFAULT_CONFIG };
