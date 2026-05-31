/**
 * streaming-model-loader.cjs
 *
 * Loads streaming mode configuration from ~/.iflow/streaming-models.json
 * and patches the Dqe (A2) adapter instance.
 *
 * Strategy: Monkey-patch A2.configureThinkingRequest and A2.configureNonThinkingRequest
 * to automatically delete p.stream and p.stream_options when the model matches
 * nonStreamModels patterns. This intercepts the stream decision INSIDE
 * generateContentInternal without modifying the source code beyond L950.
 *
 * Priority chain:
 *   1. forceNonStream (global override) → always delete stream
 *   2. nonStreamModels patterns → regex match → delete stream
 *   3. No match → preserve original stream behavior (s && p.stream = true)
 *
 * Compatible with thinking-mode-refactor and multimodal-image-refactor
 * (same insertion point L950, different load targets).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const LOG_PREFIX = '[StreamingMode]';
const CONFIG_PATH = path.join(os.homedir(), '.iflow', 'streaming-models.json');

/**
 * Default configuration — used when user config file is missing or invalid.
 */
const DEFAULT_CONFIG = {
  forceNonStream: false,
  nonStreamModels: [
    'o1-preview',
    'o1-mini',
    'o1-.*',
    'o3-.*',
    'o4-mini'
  ]
};

/**
 * Load user configuration from ~/.iflow/streaming-models.json.
 * Falls back to DEFAULT_CONFIG on missing/invalid file.
 */
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return DEFAULT_CONFIG;
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const userConfig = JSON.parse(raw);
    if (!userConfig || typeof userConfig !== 'object') return DEFAULT_CONFIG;
    const merged = { ...DEFAULT_CONFIG, ...userConfig };
    if (!Array.isArray(merged.nonStreamModels)) merged.nonStreamModels = DEFAULT_CONFIG.nonStreamModels;
    return merged;
  } catch (e) {
    console.warn(`${LOG_PREFIX} Config load failed, using defaults: ${e.message}`);
    return DEFAULT_CONFIG;
  }
}

/**
 * Check if a model name should be forced to non-stream mode.
 * @param {string} modelName
 * @param {object} config
 * @returns {boolean} true if model should NOT use streaming
 */
function shouldForceNonStream(modelName, config) {
  if (config.forceNonStream === true) return true;
  if (!modelName || typeof modelName !== 'string') return false;
  const name = modelName.toLowerCase();
  for (const pattern of config.nonStreamModels) {
    try {
      if (new RegExp(pattern, 'i').test(name)) return true;
    } catch (e) {
      console.warn(`${LOG_PREFIX} Invalid regex pattern "${pattern}": ${e.message}`);
      if (name.includes(pattern.toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * Remove stream and stream_options from a request body object.
 * @param {object} requestBody
 */
function removeStreamFields(requestBody) {
  if ('stream' in requestBody) delete requestBody.stream;
  if ('stream_options' in requestBody) delete requestBody.stream_options;
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

  adapter._streamingConfig = config;
  adapter._forceNonStreamOverride = null; // null = auto (config-based), true = force non-stream, false = force stream

  adapter.shouldForceNonStream = function(modelName) {
    // Runtime override takes priority
    if (this._forceNonStreamOverride !== null) return this._forceNonStreamOverride;
    return shouldForceNonStream(modelName, this._streamingConfig);
  };

  adapter.isStreamingModeSupported = function(modelName) {
    // All models support streaming mode toggle — user can Ctrl+S on any model
    // to switch between stream and non-stream at runtime.
    if (!modelName || typeof modelName !== 'string') return false;
    return true;
  };

  adapter.toggleForceNonStream = function(modelName) {
    if (this._forceNonStreamOverride === null) {
      // Auto mode: toggle to opposite of config-based result
      this._forceNonStreamOverride = !shouldForceNonStream(modelName, this._streamingConfig);
    } else {
      // Already overridden: toggle the override
      this._forceNonStreamOverride = !this._forceNonStreamOverride;
    }
    return this._forceNonStreamOverride;
  };

  adapter.getStreamingModeEnabled = function(modelName) {
    // Returns true if streaming is enabled (non-stream is NOT forced)
    return !this.shouldForceNonStream(modelName);
  };

  adapter.setStreamingModeEnabled = function(enabled) {
    // Set streaming mode: true = stream enabled, false = non-stream forced
    this._forceNonStreamOverride = !enabled;
  };

  adapter.resetStreamingModeOverride = function() {
    // Reset to auto (config-based) mode
    this._forceNonStreamOverride = null;
  };

  // Monkey-patch A2.configureThinkingRequest
  const originalConfigureThinkingRequest = adapter.configureThinkingRequest;
  if (typeof originalConfigureThinkingRequest === 'function') {
    adapter.configureThinkingRequest = function(modelName, requestBody, thinkingConfig) {
      const result = originalConfigureThinkingRequest.call(this, modelName, requestBody, thinkingConfig);
      if (this.shouldForceNonStream(modelName)) {
        removeStreamFields(requestBody);
      }
      return result;
    };
  }

  // Monkey-patch A2.configureNonThinkingRequest
  const originalConfigureNonThinkingRequest = adapter.configureNonThinkingRequest;
  if (typeof originalConfigureNonThinkingRequest === 'function') {
    adapter.configureNonThinkingRequest = function(modelName, requestBody) {
      const result = originalConfigureNonThinkingRequest.call(this, modelName, requestBody);
      if (this.shouldForceNonStream(modelName)) {
        removeStreamFields(requestBody);
      }
      return result;
    };
  }

  adapter.getStreamingConfig = function() { return this._streamingConfig; };
  adapter.updateStreamingConfig = function(newConfig) {
    this._streamingConfig = { ...this._streamingConfig, ...newConfig };
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(this._streamingConfig, null, 2), 'utf-8');
    } catch (e) {
      console.warn(`${LOG_PREFIX} Config save failed: ${e.message}`);
    }
    return true;
  };

  console.log(`${LOG_PREFIX} forceNonStream: ${config.forceNonStream}`);
  console.log(`${LOG_PREFIX} nonStreamModels: ${config.nonStreamModels.length} patterns`);
  console.log(`${LOG_PREFIX} Patched configureThinkingRequest and configureNonThinkingRequest`);

  return adapter;
}

module.exports = { load, loadConfig, shouldForceNonStream, DEFAULT_CONFIG };