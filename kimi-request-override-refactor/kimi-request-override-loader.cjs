/**
 * kimi-request-override-loader.cjs
 *
 * Loads model request override rules from ~/.iflow/kimi-request-overrides.json
 * and patches the Dqe (A2) adapter instance.
 *
 * Strategy: Monkey-patch A2.configureThinkingRequest and A2.configureNonThinkingRequest
 * to normalize requestBody fields for Kimi models with fixed parameter requirements.
 *
 * Current use case:
 *   - Kimi K3 requires fixed sampling parameters
 *   - Kimi K3 uses reasoning_effort instead of legacy thinking fields
 *
 * Compatible with thinking-mode-refactor, streaming-mode-refactor,
 * multimodal-image-refactor, and other A2 patch mods.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const LOG_PREFIX = '[KimiRequestOverride]';
const CONFIG_PATH = path.join(os.homedir(), '.iflow', 'kimi-request-overrides.json');

const DEFAULT_CONFIG = {
  requestOverrides: [
    {
      pattern: '^kimi-k3(?:$|[-.:])',
      set: {
        temperature: 1,
        top_p: 0.95,
        presence_penalty: 0,
        frequency_penalty: 0
      },
      delete: [
        'thinking'
      ],
      setIfMissing: {
        reasoning_effort: 'max'
      }
    }
  ]
};

function normalizeLegacyConfig(config) {
  const normalized = { ...config };

  if (!Array.isArray(normalized.requestOverrides) || normalized.requestOverrides.length === 0) {
    const legacyRules = Array.isArray(normalized.forceTemperatureModels)
      ? normalized.forceTemperatureModels
      : [];

    normalized.requestOverrides = legacyRules
      .filter(rule => rule && typeof rule === 'object' && typeof rule.pattern === 'string')
      .map(rule => ({
        pattern: rule.pattern,
        set: typeof rule.temperature === 'number'
          ? { temperature: rule.temperature }
          : {}
      }));
  }

  if (!Array.isArray(normalized.requestOverrides) || normalized.requestOverrides.length === 0) {
    normalized.requestOverrides = DEFAULT_CONFIG.requestOverrides;
  }

  return normalized;
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const userConfig = JSON.parse(raw);
    if (!userConfig || typeof userConfig !== 'object') return DEFAULT_CONFIG;
    return normalizeLegacyConfig({ ...DEFAULT_CONFIG, ...userConfig });
  } catch (e) {
    console.warn(`${LOG_PREFIX} Config load failed, using defaults: ${e.message}`);
    return DEFAULT_CONFIG;
  }
}

function matchesPattern(modelName, pattern) {
  if (!modelName || typeof modelName !== 'string' || typeof pattern !== 'string') {
    return false;
  }

  try {
    return new RegExp(pattern, 'i').test(modelName);
  } catch (e) {
    console.warn(`${LOG_PREFIX} Invalid regex pattern "${pattern}": ${e.message}`);
    return modelName.toLowerCase().includes(pattern.toLowerCase());
  }
}

function getMatchedOverrides(modelName, config) {
  if (!modelName || typeof modelName !== 'string') return [];
  const rules = Array.isArray(config?.requestOverrides)
    ? config.requestOverrides
    : [];

  return rules.filter(rule => rule && typeof rule === 'object' && matchesPattern(modelName, rule.pattern));
}

function applyOverrideRule(requestBody, rule) {
  if (!requestBody || typeof requestBody !== 'object' || !rule || typeof rule !== 'object') {
    return;
  }

  if (rule.set && typeof rule.set === 'object') {
    for (const [key, value] of Object.entries(rule.set)) {
      requestBody[key] = value;
    }
  }

  if (Array.isArray(rule.delete)) {
    for (const key of rule.delete) {
      if (typeof key === 'string' && key in requestBody) {
        delete requestBody[key];
      }
    }
  }

  if (rule.setIfMissing && typeof rule.setIfMissing === 'object') {
    for (const [key, value] of Object.entries(rule.setIfMissing)) {
      if (requestBody[key] === undefined) {
        requestBody[key] = value;
      }
    }
  }
}

function applyRequestOverrides(modelName, requestBody, config) {
  if (!requestBody || typeof requestBody !== 'object') return;
  const matchedRules = getMatchedOverrides(modelName, config);
  for (const rule of matchedRules) {
    applyOverrideRule(requestBody, rule);
  }
}

function load(adapter) {
  const config = loadConfig();

  if (!adapter || typeof adapter !== 'object') {
    console.warn(`${LOG_PREFIX} Invalid adapter, skipping setup`);
    return;
  }

  adapter._kimiRequestOverrideConfig = config;

  const originalConfigureThinkingRequest = adapter.configureThinkingRequest;
  if (typeof originalConfigureThinkingRequest === 'function') {
    adapter.configureThinkingRequest = function(modelName, requestBody, thinkingConfig) {
      const result = originalConfigureThinkingRequest.call(this, modelName, requestBody, thinkingConfig);
      applyRequestOverrides(modelName, requestBody, this._kimiRequestOverrideConfig);
      return result;
    };
  }

  const originalConfigureNonThinkingRequest = adapter.configureNonThinkingRequest;
  if (typeof originalConfigureNonThinkingRequest === 'function') {
    adapter.configureNonThinkingRequest = function(modelName, requestBody) {
      const result = originalConfigureNonThinkingRequest.call(this, modelName, requestBody);
      applyRequestOverrides(modelName, requestBody, this._kimiRequestOverrideConfig);
      return result;
    };
  }

  adapter.getKimiRequestOverrideConfig = function() {
    return this._kimiRequestOverrideConfig;
  };

  adapter.updateKimiRequestOverrideConfig = function(newConfig) {
    this._kimiRequestOverrideConfig = normalizeLegacyConfig({ ...this._kimiRequestOverrideConfig, ...newConfig });
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this._kimiRequestOverrideConfig, null, 2), 'utf-8');
    } catch (e) {
      console.warn(`${LOG_PREFIX} Config save failed: ${e.message}`);
    }
    return true;
  };

  console.log(`${LOG_PREFIX} requestOverrides: ${config.requestOverrides.length} rules`);
  console.log(`${LOG_PREFIX} Patched configureThinkingRequest and configureNonThinkingRequest`);

  return adapter;
}

module.exports = {
  load,
  loadConfig,
  normalizeLegacyConfig,
  matchesPattern,
  getMatchedOverrides,
  applyOverrideRule,
  applyRequestOverrides,
  DEFAULT_CONFIG
};
