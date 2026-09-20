/**
 * stream-toolcall-repair-loader.cjs
 *
 * Repair layer for OpenAIContentGenerator.parseStreamResponse (L961).
 *
 * Problem solved (see empty-command-error-analysis.md):
 *   In --stream mode (forced by ACP extensions), tool_calls arrive as SSE
 *   delta fragments. The builtin reassembler:
 *     ① keys its reassembly map ONLY by `id` (`y.id ?? this.currentToolCallId`),
 *       ignoring the OpenAI-spec `index` field. Endpoints that omit `id` on
 *       continuation chunks (e.g. sensenova) get fragments appended to the
 *       wrong call → corrupted arguments JSON.
 *     ② falls back to `args: {}` when JSON.parse(reassembled) fails. The empty
 *       object passes the consumer's `typeof args !== "undefined"` guard, so
 *       run_shell_command.execute() receives no `command` and the turn fails
 *       with "Internal Error: 命令不能为空".
 *     ③ drops calls whose `name` arrives after the first fragment (entry is
 *       created with name:"" and never updated).
 *
 * Strategy:
 *   code.js inserts ONE delegation statement at the top of the original
 *   `async*parseStreamResponse(e){` body. The method asks this loader for a
 *   replacement generator; when the loader returns null (disabled / model not
 *   matched / file missing) the original implementation runs untouched.
 *
 * Fixes in the replacement parser:
 *   1. Fragments are aligned by OpenAI-spec `index` (with id as secondary
 *      key), so id-less continuation chunks land on the right call and
 *      parallel tool calls stay separated (dual index/id → entry mapping).
 *   2. Malformed reassembled arguments are DROPPED by default instead of
 *      being dispatched as `args:{}` (config: onParseError "drop"|"empty").
 *      A call whose arguments never arrive at all ("" — legal no-arg call)
 *      is still emitted as `{}` unless dropEmptyArgs is enabled.
 *   3. Optional local salvage for truncated JSON (repairTruncatedJson):
 *      closes unterminated strings, drops dangling keys, fills missing
 *      values with null, then closes unbalanced braces/brackets.
 *   4. Entries are completed as fragments arrive: late `id`/`name` updates
 *      the entry, and the partial functionCall card (args:undefined, used
 *      by TUI/ACP pending UI) is yielded exactly once per call.
 *
 * Zero side effects when not streaming or when disabled: the delegation in
 * code.js catches every error and falls back to the builtin parser.
 *
 * Config: ~/.iflow/stream-toolcall-repair.json (hot-reloaded, 5s TTL).
 * Runtime APIs on global: getStreamToolCallRepairConfig(),
 *   updateStreamToolCallRepairConfig(), reloadStreamToolCallRepairConfig(),
 *   shouldRepairStreamModel(model).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const LOG_PREFIX = '[StreamToolCallRepair]';
const CONFIG_PATH = path.join(os.homedir(), '.iflow', 'stream-toolcall-repair.json');
const CONFIG_TTL_MS = 5000;

/**
 * Default configuration — used when the user config file is missing/invalid.
 * enabled + empty modelPatterns means: repair every model's stream.
 */
const DEFAULT_CONFIG = {
  version: '1.0.0',
  enabled: true,
  modelPatterns: [],
  onParseError: 'drop',
  repairTruncatedJson: true,
  dropEmptyArgs: false,
  logDropped: true
};

/** Sentinel returned by parseToolArgs when a call must be skipped. */
const SKIP = Symbol('stream-toolcall-repair.skip');

let cachedConfig = null;
let cachedAt = 0;

/**
 * Merge user config over defaults and validate every field.
 */
function normalizeConfig(userConfig) {
  const merged = { ...DEFAULT_CONFIG, ...(userConfig || {}) };
  merged.enabled = merged.enabled !== false;
  if (merged.onParseError !== 'drop' && merged.onParseError !== 'empty') {
    if (userConfig && userConfig.onParseError !== undefined) {
      console.warn(`${LOG_PREFIX} Unknown onParseError "${userConfig.onParseError}", falling back to "drop"`);
    }
    merged.onParseError = 'drop';
  }
  merged.repairTruncatedJson = merged.repairTruncatedJson !== false;
  merged.dropEmptyArgs = merged.dropEmptyArgs === true;
  merged.logDropped = merged.logDropped !== false;
  if (!Array.isArray(merged.modelPatterns)) merged.modelPatterns = [];
  merged.modelPatterns = merged.modelPatterns.filter(
    (p) => typeof p === 'string' && p.length > 0
  );
  return merged;
}

/**
 * Load user configuration from ~/.iflow/stream-toolcall-repair.json.
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
 * Config getter with a short TTL so edits take effect within seconds
 * without restarting iFlow (same convention as context-window-refactor).
 */
function getConfig() {
  const now = Date.now();
  if (!cachedConfig || now - cachedAt > CONFIG_TTL_MS) {
    cachedConfig = loadConfig();
    cachedAt = now;
  }
  return cachedConfig;
}

/**
 * Decide whether the repaired parser should handle this model.
 * Empty modelPatterns = all models; otherwise first matching regex wins.
 */
function shouldHandle(modelName, config) {
  if (!config.enabled) return false;
  if (config.modelPatterns.length === 0) return true;
  const name = (modelName || '').toLowerCase();
  for (const pattern of config.modelPatterns) {
    try {
      if (new RegExp(pattern, 'i').test(name)) return true;
    } catch (e) {
      console.warn(`${LOG_PREFIX} Invalid regex pattern "${pattern}": ${e.message}`);
      if (name.includes(pattern.toLowerCase())) return true;
    }
  }
  return false;
}

function safeGetModel(generator) {
  try {
    return generator?.config?.getModel?.() || '';
  } catch {
    return '';
  }
}

/**
 * Same id-fallback shape as convertToOpenAIMessages (L956).
 */
function fallbackId() {
  return `call_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Fix ① — dual mapping: OpenAI streams identify a call fragment by `index`,
 * some endpoints additionally/only send `id`. Keep both maps pointing at the
 * same entry so fragments align regardless of which field the endpoint emits.
 * Entries are completed in place when late id/name fragments arrive.
 */
function resolveEntry(tc, state) {
  const hasIndex = typeof tc?.index === 'number';
  let entry = null;
  if (hasIndex && state.byIndex.has(tc.index)) entry = state.byIndex.get(tc.index);
  if (!entry && tc?.id && state.byId.has(tc.id)) entry = state.byId.get(tc.id);
  if (!entry && !hasIndex && !tc?.id) entry = state.lastEntry; // id-less, index-less tail fragment
  if (!entry) {
    entry = { id: '', name: '', args: '', yielded: false };
    state.entries.push(entry);
  }
  if (hasIndex) state.byIndex.set(tc.index, entry);
  if (tc?.id) {
    state.byId.set(tc.id, entry);
    entry.id = tc.id;
    state.generator.currentToolCallId = tc.id;
  }
  if (tc?.function?.name) entry.name = tc.function.name;
  state.lastEntry = entry;
  return entry;
}

/**
 * Conservative salvage for truncated tool-call arguments. Only ever invoked
 * AFTER JSON.parse has failed, so it can never corrupt a healthy payload.
 * Throws when the result is still not parseable — caller treats as failure.
 */
function repairTruncatedJson(raw) {
  if (typeof raw !== 'string') throw new Error('not a string');
  let s = raw.trim();
  if (!s) throw new Error('empty');
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack[stack.length - 1] === ch) stack.pop();
    }
  }
  if (escaped) s = s.slice(0, -1); // dangling backslash at cut point
  if (inString) s += '"';
  if (/:\s*$/.test(s)) s += 'null'; // value cut off right after ":"
  s = s.replace(/,\s*"[^"]*"\s*$/, ''); // dangling key: {"a":1,"ke
  s = s.replace(/,\s*$/, ''); // trailing comma
  if (/^\{\s*"[^"]*"\s*$/.test(s)) s = '{'; // object holding only a dangling key
  while (stack.length) s += stack.pop();
  return s;
}

/**
 * Fix ②/③ — turn one reassembled entry into dispatchable args, or SKIP.
 * Empty fragment stream ("") is a legal no-arg call → {} (unless configured
 * to drop those too). Unparseable payloads are repaired locally (optional),
 * then either dropped (default) or emitted as legacy {} (onParseError).
 */
function parseToolArgs(entry, config, model) {
  const raw = entry.args;
  if (!raw || raw.trim() === '') {
    return config.dropEmptyArgs ? SKIP : {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    // fall through to repair/drop
  }
  if (config.repairTruncatedJson) {
    try {
      const parsed = JSON.parse(repairTruncatedJson(raw));
      if (config.logDropped) {
        console.warn(`${LOG_PREFIX} repaired truncated arguments for "${entry.name}" (model: ${model || 'unknown'})`);
      }
      return parsed;
    } catch {
      // still broken — apply onParseError policy
    }
  }
  if (config.onParseError === 'empty') return {};
  if (config.logDropped) {
    const preview = raw.length > 120 ? `${raw.slice(0, 120)}...` : raw;
    console.warn(`${LOG_PREFIX} dropping malformed tool call "${entry.name}" (model: ${model || 'unknown'}): ${preview}`);
  }
  return SKIP;
}

/**
 * Repaired port of the builtin parseStreamResponse (L961-L962).
 * `generator` is the OpenAIContentGenerator instance (`this` at the call
 * site); behaviour mirrors the original chunk-for-chunk except for the
 * three fixes documented above.
 */
async function* parseStream(generator, response, config, model) {
  if (!response.body) throw new Error('Response body is null');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const state = {
    generator,
    byIndex: new Map(),
    byId: new Map(),
    entries: [],
    lastEntry: null
  };
  let usage;
  let lastThoughtContent = null;
  generator.currentToolCallId = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line === 'data: [DONE]' || line === 'data:[DONE]' || !line.startsWith('data:')) continue;
        try {
          const payload = line.startsWith('data: ') ? line.slice(6) : line.slice(5);
          const json = JSON.parse(payload);
          if (json.usage) {
            generator.saveUsageMetadata(json.usage);
            usage = {
              promptTokenCount: generator.lastUsageMetadata?.prompt_tokens || 0,
              candidatesTokenCount: generator.lastUsageMetadata?.completion_tokens || 0,
              totalTokenCount: generator.lastUsageMetadata?.total_tokens || 0
            };
          }
          if (!json.choices || json.choices.length === 0) continue;
          const choice = json.choices[0];
          const delta = choice.delta;

          if (delta?.reasoning_content !== null && delta?.reasoning_content !== undefined) {
            const resp = generator.createGeminiResponse();
            const candidate = resp.candidates?.[0];
            if (candidate?.content?.parts) {
              candidate.content.parts = [{ thought: true, text: delta.reasoning_content }];
              lastThoughtContent = candidate.content;
            }
            yield resp;
          }
          if (delta?.signature && typeof delta.signature === 'string' && lastThoughtContent?.parts) {
            for (const part of lastThoughtContent.parts) {
              if (part.thought === true) part.thoughtSignature = delta.signature;
            }
            lastThoughtContent = null;
          }
          if (delta?.content) {
            const resp = generator.createGeminiResponse();
            const candidate = resp.candidates?.[0];
            if (candidate?.content?.parts) candidate.content.parts = [{ text: delta.content }];
            yield resp;
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const entry = resolveEntry(tc, state);
              if (!entry.yielded && entry.id && entry.name) {
                // Partial card (args:undefined) drives the pending-tool UI in
                // both TUI and ACP; emit exactly once per logical call.
                entry.yielded = true;
                const resp = generator.createGeminiResponse();
                resp.candidates?.[0]?.content?.parts?.push({
                  functionCall: { id: entry.id, name: entry.name, args: undefined }
                });
                yield resp;
              }
              if (tc.function?.arguments) entry.args += tc.function.arguments;
            }
          }

          if (choice.finish_reason && (state.entries.length > 0 || usage)) {
            const resp = generator.createGeminiResponse();
            const candidate = resp.candidates?.[0];
            if (candidate) {
              candidate.finishReason = generator.mapFinishReason(choice.finish_reason);
              if (candidate.content?.parts && state.entries.length > 0) {
                for (const entry of state.entries) {
                  if (!entry || !entry.name) continue;
                  const args = parseToolArgs(entry, config, model);
                  if (args === SKIP) continue;
                  candidate.content.parts.push({
                    functionCall: { id: entry.id || fallbackId(), name: entry.name, args }
                  });
                }
              }
            }
            if (usage) resp.usageMetadata = usage;
            yield resp;
          }
        } catch (err) {
          console.error('Failed to parse SSE chunk:', line, err);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Entry point invoked by the delegation statement inside code.js.
 * `this` is the OpenAIContentGenerator instance.
 * @returns {AsyncGenerator|null} replacement parser, or null to let the
 *   builtin implementation run (disabled, model not matched).
 */
function parseStreamResponse(response) {
  const config = getConfig();
  if (!config.enabled) return null;
  const model = safeGetModel(this);
  if (!shouldHandle(model, config)) return null;
  const generator = this;
  return (async function* () {
    yield* parseStream(generator, response, config, model);
  })();
}

// Runtime APIs (no adapter instance available at this insertion point — the
// content generator class lives inside a module closure — so they hang off
// global, consistent with command-api-refactor's global API convention).
global.getStreamToolCallRepairConfig = function () {
  return getConfig();
};

global.updateStreamToolCallRepairConfig = function (newConfig) {
  cachedConfig = normalizeConfig({ ...getConfig(), ...(newConfig || {}) });
  cachedAt = Date.now();
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cachedConfig, null, 2), 'utf-8');
  } catch (e) {
    console.warn(`${LOG_PREFIX} Config save failed: ${e.message}`);
  }
  return true;
};

global.reloadStreamToolCallRepairConfig = function () {
  cachedConfig = loadConfig();
  cachedAt = Date.now();
  return cachedConfig;
};

global.shouldRepairStreamModel = function (model) {
  return shouldHandle(model, getConfig());
};

module.exports = {
  parseStreamResponse,
  shouldHandle,
  loadConfig,
  repairTruncatedJson,
  DEFAULT_CONFIG
};
