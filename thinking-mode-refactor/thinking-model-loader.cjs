/**
 * thinking-model-loader.js
 *
 * Loads model thinking capability rules from ~/.iflow/thinking-models.json
 * and registers them on the Dqe (A2) adapter instance.
 *
 * DSL Compiler — converts declarative JSON rules into (req, config) => void functions.
 * Supports: set, delete, setNested, setConditional, setTemplate
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.iflow', 'thinking-models.json');

/**
 * Set a nested value on an object using a dot-separated path.
 * e.g. setNested(req, 'thinking.type', 'enabled') → req.thinking.type = 'enabled'
 */
function setNested(obj, dotPath, value) {
  const keys = dotPath.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}

/**
 * Delete a nested value from an object using a dot-separated path.
 * e.g. deleteNested(req, 'thinking.type') → delete req.thinking.type
 */
function deleteNested(obj, dotPath) {
  const keys = dotPath.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!(keys[i] in current)) return;
    current = current[keys[i]];
  }
  delete current[keys[keys.length - 1]];
}

/**
 * Compile a DSL block into a (req, config) => void function.
 * @param {object} dsl
 * @returns {(req: object, config: object) => void}
 */
function compileThinkingRequest(dsl) {
  const actions = [];

  // set: top-level fields
  if (dsl.set && typeof dsl.set === 'object') {
    for (const [key, value] of Object.entries(dsl.set)) {
      actions.push((req, config) => { req[key] = value; });
    }
  }

  // delete: top-level fields
  if (Array.isArray(dsl.delete)) {
    for (const key of dsl.delete) {
      actions.push((req, config) => {
        if (key.includes('.')) {
          deleteNested(req, key);
        } else {
          delete req[key];
        }
      });
    }
  }

  // setNested: dot-path nested fields
  if (dsl.setNested && typeof dsl.setNested === 'object') {
    for (const [dotPath, value] of Object.entries(dsl.setNested)) {
      actions.push((req, config) => { setNested(req, dotPath, value); });
    }
  }

  // setConditional: conditionally set fields based on config (reasoningLevel, maxTokens)
  if (Array.isArray(dsl.setConditional)) {
    for (const cond of dsl.setConditional) {
      if (!cond.when || !cond.set) continue;
      const conditions = Object.entries(cond.when);
      actions.push((req, config) => {
        let match = true;
        for (const [cfgKey, condition] of conditions) {
          const actualValue = config[cfgKey];
          if (condition.eq !== undefined && actualValue !== condition.eq) { match = false; break; }
          if (condition.ne !== undefined && actualValue === condition.ne) { match = false; break; }
          if (condition.regex && !new RegExp(condition.regex, 'i').test(String(actualValue))) { match = false; break; }
        }
        if (match) {
          for (const [key, value] of Object.entries(cond.set)) {
            if (key.includes('.')) {
              setNested(req, key, value);
            } else {
              req[key] = value;
            }
          }
        }
      });
    }
  }

  // setTemplate: template strings with {{var}} substitution from config
  // Pure {{var}} references preserve the original type (number, boolean, etc.)
  if (dsl.setTemplate && typeof dsl.setTemplate === 'object') {
    for (const [key, tpl] of Object.entries(dsl.setTemplate)) {
      if (typeof tpl !== 'string') continue;
      actions.push((req, config) => {
        // Check if template is a pure {{var}} reference (preserve original type)
        const pureVarMatch = tpl.match(/^\{\{(\w+)\}\}$/);
        if (pureVarMatch && pureVarMatch[1] in config) {
          const value = config[pureVarMatch[1]];
          if (key.includes('.')) {
            setNested(req, key, value);
          } else {
            req[key] = value;
          }
          return;
        }
        // Otherwise, perform string template substitution
        const value = tpl.replace(/\{\{(\w+)\}\}/g, (_, varName) => {
          if (varName in config) return String(config[varName]);
          return '';
        });
        if (key.includes('.')) {
          setNested(req, key, value);
        } else {
          req[key] = value;
        }
      });
    }
  }

  if (actions.length === 0) return null;

  return (req, config) => {
    for (const action of actions) {
      action(req, config || {});
    }
  };
}

/**
 * Compile a DSL block into a (req) => void function for non-thinking requests.
 * Same DSL structure but doesn't receive config.
 */
function compileNonThinkingRequest(dsl) {
  const actions = [];

  if (dsl.set && typeof dsl.set === 'object') {
    for (const [key, value] of Object.entries(dsl.set)) {
      actions.push((req) => { req[key] = value; });
    }
  }

  if (Array.isArray(dsl.delete)) {
    for (const key of dsl.delete) {
      actions.push((req) => {
        if (key.includes('.')) {
          deleteNested(req, key);
        } else {
          delete req[key];
        }
      });
    }
  }

  if (dsl.setNested && typeof dsl.setNested === 'object') {
    for (const [dotPath, value] of Object.entries(dsl.setNested)) {
      actions.push((req) => { setNested(req, dotPath, value); });
    }
  }

  if (Array.isArray(dsl.setConditional)) {
    for (const cond of dsl.setConditional) {
      if (!cond.when || !cond.set) continue;
      actions.push((req) => {
        for (const [key, value] of Object.entries(cond.set)) {
          if (key.includes('.')) {
            setNested(req, key, value);
          } else {
            req[key] = value;
          }
        }
      });
    }
  }

  if (dsl.setTemplate && typeof dsl.setTemplate === 'object') {
    for (const [key, tpl] of Object.entries(dsl.setTemplate)) {
      if (typeof tpl !== 'string') continue;
      actions.push((req) => {
        const pureVarMatch = tpl.match(/^\{\{(\w+)\}\}$/);
        if (pureVarMatch) {
          // No config available in non-thinking mode; skip dynamic vars
          return;
        }
        const value = tpl.replace(/\{\{(\w+)\}\}/g, () => '');
        if (key.includes('.')) {
          setNested(req, key, value);
        } else {
          req[key] = value;
        }
      });
    }
  }

  if (actions.length === 0) return null;

  return (req) => {
    for (const action of actions) {
      action(req);
    }
  };
}

/**
 * Build a capability object from a JSON rule.
 */
function buildCapability(rule) {
  const cap = {
    supportsThinking: rule.supportsThinking,
    supportedReasoningLevels: rule.supportedReasoningLevels || ['low', 'medium', 'high'],
    maxThinkingTokens: rule.maxThinkingTokens || 0
  };

  if (rule.thinkingRequest) {
    const fn = compileThinkingRequest(rule.thinkingRequest);
    if (fn) cap.configureRequest = fn;
  }

  if (rule.nonThinkingRequest) {
    const fn = compileNonThinkingRequest(rule.nonThinkingRequest);
    if (fn) cap.configureNonThinkingRequest = fn;
  }

  return cap;
}

/**
 * Load thinking model rules from config file and register on the adapter.
 * @param {object} adapter - Dqe instance (A2)
 */
function load(adapter) {
  let config;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = JSON.parse(raw);
  } catch (e) {
    // File not found or invalid JSON → silently use built-in rules
    return;
  }

  if (!config || !Array.isArray(config.models)) return;

  let loadedCount = 0;
  for (const rule of config.models) {
    try {
      if (!rule.pattern || typeof rule.supportsThinking !== 'boolean') {
        console.warn('[ThinkingModel] Skip: missing pattern or supportsThinking:', rule.pattern);
        continue;
      }

      const regex = new RegExp(rule.pattern, 'i');
      const cap = buildCapability(rule);
      adapter.registerModel(regex, cap);
      loadedCount++;
    } catch (e) {
      console.warn('[ThinkingModel] Rule load failed:', rule.pattern, e.message);
    }
  }

  if (loadedCount > 0) {
    console.log(`[ThinkingModel] Loaded ${loadedCount} model rules from ${CONFIG_PATH}`);
  }
}

module.exports = { load };