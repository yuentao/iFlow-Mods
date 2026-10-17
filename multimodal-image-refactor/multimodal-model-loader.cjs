/**
 * multimodal-model-loader.cjs
 *
 * Loads multimodal model recognition rules from ~/.iflow/multimodal-models.json
 * and patches the MultimodalHelper (_4) class.
 *
 * Features:
 * 1. isMultimodalModel() 配置化 — 外部 JSON 覆盖硬编码模型列表
 * 2. 视觉模型路由配置化 — 用户指定图片描述使用的模型名 (descriptionModel)
 * 3. directMultimodal 模式 — 强制所有模型直接传递图片
 *
 * 已修复的原版缺陷：
 *   Config.getMultimodalModelName() 只在 iFlow 官方登录模式下返回 "qwen3-vl-plus"，
 *   OpenAI Compatible 模式下返回 undefined。于是 Config.getMultimodalHelper()
 *   构造出的 MultimodalHelper 实例 modelName === ""，凡是走该实例的调用
 *   （image_read 工具、read_file 读图片）都会立刻抛出
 *   "No multimodal model specified for image description"。
 *   用户在对话里贴图不受影响 —— 那条路径由 convertToOpenAIMessages() 直接以
 *   image_url 传图，根本不经过 MultimodalHelper。
 *
 *   因此这里统一接管 generateImageDescription / generateImageDescriptionFromPrompt，
 *   按 descriptionModel → Aone/iFlow 内置路由 → 实例 modelName →
 *   settings.json 当前主模型 的顺序解析视觉模型。
 *
 * Compatible with thinking-mode-refactor (different load target: _4 vs A2).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.iflow', 'multimodal-models.json');

// iFlow 自身的设置目录解析：IFLOW_HOME 优先，否则 ~/.iflow
const SETTINGS_PATH = process.env.IFLOW_HOME
  ? path.join(process.env.IFLOW_HOME, 'settings.json')
  : path.join(os.homedir(), '.iflow', 'settings.json');

const SETTINGS_TTL_MS = 5000;

let cachedModelName = '';
let settingsCheckedAt = 0;
let settingsMtimeMs = -1;

/**
 * 读取 settings.json 中当前生效的主模型名（TTL + mtime 缓存）。
 * /model 切换与 API Profile 切换都会写入该字段，因此改动数秒内生效。
 * @returns {string} 模型名，读取失败或未配置时返回空字符串
 */
function readCurrentModelName() {
  const now = Date.now();
  if (now - settingsCheckedAt < SETTINGS_TTL_MS) return cachedModelName;
  settingsCheckedAt = now;
  try {
    const stat = fs.statSync(SETTINGS_PATH);
    if (stat.mtimeMs === settingsMtimeMs) return cachedModelName;
    settingsMtimeMs = stat.mtimeMs;
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    const name = parsed && typeof parsed.modelName === 'string' ? parsed.modelName.trim() : '';
    cachedModelName = name;
  } catch {
    cachedModelName = '';
    settingsMtimeMs = -1;
  }
  return cachedModelName;
}
/**
 * Load multimodal model rules from config file and patch the MultimodalHelper class.
 * @param {Function} MultimodalHelperClass - The _4 class (MultimodalHelper)
 */
function load(MultimodalHelperClass) {
  if (!MultimodalHelperClass || typeof MultimodalHelperClass !== 'function') return;
  if (typeof MultimodalHelperClass.isMultimodalModel !== 'function') return;
  if (!MultimodalHelperClass.prototype) return;

  // 配置缺失或 JSON 非法时按空配置继续：识别规则回退原始硬编码，
  // 但视觉模型解析修复仍然生效。
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
  } catch {
    config = {};
  }

  // --- Feature 1 / Feature 3: isMultimodalModel() ---
  const originalIsMultimodalModel = MultimodalHelperClass.isMultimodalModel.bind(MultimodalHelperClass);

  if (config.directMultimodal === true) {
    // 强制所有模型被视为多模态，图片直接以 image_url 传递
    MultimodalHelperClass.isMultimodalModel = function() { return true; };
    console.log('[MultimodalModel] directMultimodal enabled — all models treated as multimodal');
  } else {
    MultimodalHelperClass.isMultimodalModel = function(modelName) {
      if (!modelName) return false;
      const n = modelName.toLowerCase();

      // 1. 用户排除列表（优先级最高，显式排除）
      if (Array.isArray(config.nonMultimodalModels) && config.nonMultimodalModels.length > 0) {
        if (config.nonMultimodalModels.some(m => n.includes(m.toLowerCase()))) {
          return false;
        }
      }

      // 2. 用户模型列表（contains 匹配）
      if (Array.isArray(config.multimodalModels) && config.multimodalModels.length > 0) {
        if (config.multimodalModels.some(m => n.includes(m.toLowerCase()))) {
          return true;
        }
      }

      // 3. 用户模式匹配规则（正则）
      if (Array.isArray(config.multimodalPatterns) && config.multimodalPatterns.length > 0) {
        for (const pattern of config.multimodalPatterns) {
          try {
            if (new RegExp(pattern, 'i').test(modelName)) return true;
          } catch (e) {
            console.warn('[MultimodalModel] Invalid pattern:', pattern, e.message);
          }
        }
      }

      // 4. 回退到原始方法（保留硬编码列表 + vision/visual/vl 模式匹配）
      return originalIsMultimodalModel(modelName);
    };
  }

  // --- Feature 2: 视觉模型路由（含 image_read / read_file 读图路径修复） ---
  const userModel = typeof config.descriptionModel === 'string' ? config.descriptionModel.trim() : '';
  const userConfig = config.descriptionModelConfig || {};
  let loggedFallbackModel = '';

  /**
   * 解析本次图片描述请求应使用的视觉模型。
   * 优先级：descriptionModel > Aone 内置 > iFlow 内置 > 实例 modelName > settings.json 主模型
   * @returns {string} 模型名，无法解析时返回空字符串
   */
  function resolveDescriptionModel(helper) {
    if (userModel) return userModel;

    const baseUrl = typeof helper.baseUrl === 'string' ? helper.baseUrl : '';
    if (helper.isAoneMode && baseUrl === 'https://ducky.code.alibaba-inc.com/v1/openai') {
      return 'Qwen2.5-VL-72B_aone';
    }
    if (helper.isIFlowMode && (baseUrl === 'https://apis.iflow.cn/v1' || baseUrl.includes('iflow'))) {
      return 'qwen3-vl-plus';
    }
    // Feature 4: patched bundle construction sites pass a live getter
    // (re-reads contentGeneratorConfig.model per call, so set_model takes
    // effect even though Config caches the helper instance).
    const holder = helper.modelName;
    if (typeof holder === 'function') {
      let live = '';
      try {
        const value = holder();
        if (typeof value === 'string') live = value.trim();
      } catch {
        live = '';
      }
      if (live && MultimodalHelperClass.isMultimodalModel(live)) return live;
    } else if (typeof holder === 'string' && holder.trim() !== '') {
      return holder.trim();
    }

    // 原版在 OpenAI Compatible 模式下不会给实例传入任何模型名，导致工具读图直接报错。
    // 兜底使用当前主模型，但仅当它被判定为多模态时才敢把图片发过去。
    const currentModel = readCurrentModelName();
    if (currentModel && MultimodalHelperClass.isMultimodalModel(currentModel)) {
      if (loggedFallbackModel !== currentModel) {
        loggedFallbackModel = currentModel;
        console.log(`[MultimodalModel] image description falls back to current model: ${currentModel}`);
      }
      return currentModel;
    }
    return '';
  }

  const NO_MODEL_ERROR =
    'No multimodal model specified for image description ' +
    '(set "descriptionModel" in ~/.iflow/multimodal-models.json)';

  MultimodalHelperClass.prototype.generateImageDescription = async function(base64Data, mimeType) {
    const model = resolveDescriptionModel(this);
    if (!model) throw new Error(NO_MODEL_ERROR);

    const cacheKey = this.generateCacheKey(base64Data, mimeType);
    const cached = MultimodalHelperClass.descriptionCache.get(cacheKey);
    if (cached) return cached;

    const prompt = this.createImageAnalysisPrompt();
    try {
      return await this._requestWithModel(base64Data, mimeType, prompt, model, userConfig, cacheKey);
    } catch (error) {
      throw new Error(`Image description error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  MultimodalHelperClass.prototype.generateImageDescriptionFromPrompt = async function(base64Data, mimeType, customPrompt) {
    const model = resolveDescriptionModel(this);
    if (!model) throw new Error(NO_MODEL_ERROR);

    const cacheKey = this.generateCacheKey(base64Data, mimeType, customPrompt);
    const cached = MultimodalHelperClass.descriptionCache.get(cacheKey);
    if (cached) return cached;

    const prompt = customPrompt && String(customPrompt).trim() !== ''
      ? customPrompt
      : this.createImageAnalysisPrompt();
    try {
      return await this._requestWithModel(base64Data, mimeType, prompt, model, userConfig, cacheKey);
    } catch (error) {
      throw new Error(`Image description error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // 通用请求方法 — 发送图片到视觉模型 API 并获取文字描述
  MultimodalHelperClass.prototype._requestWithModel = async function(base64Data, mimeType, prompt, model, cfg, cacheKey) {
    const body = {
      model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } }
        ]
      }],
      temperature: cfg.temperature ?? 0.1,
      max_tokens: cfg.max_tokens ?? 2000
    };

    const url = (this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl) + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        'user-agent': 'iFlow-Cli-MultimodalHelper'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error! status: ${res.status}, body: ${text} TraceID: ${res.headers.get('eagleeye-traceid')}`);
    }

    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(`Response format error. TraceID: ${res.headers.get('eagleeye-traceid')}`);
    }

    if (json.msg && json.msg.includes('invalid apiKey')) {
      throw new Error('Invalid API key provided for model');
    }

    const content = json.choices?.[0]?.message?.content;
    if (!content) throw new Error('No description generated by model');

    const result = content.trim();
    MultimodalHelperClass.descriptionCache.set(cacheKey, result);
    return result;
  };

  if (userModel) {
    console.log(`[MultimodalModel] descriptionModel set to: ${userModel}`);
  }
  console.log('[MultimodalModel] Config loaded from', CONFIG_PATH);
}

module.exports = { load };
