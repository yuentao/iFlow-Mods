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
 * Compatible with thinking-mode-refactor (different load target: _4 vs A2).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.iflow', 'multimodal-models.json');

/**
 * Load multimodal model rules from config file and patch the MultimodalHelper class.
 * @param {Function} MultimodalHelperClass - The _4 class (MultimodalHelper)
 */
function load(MultimodalHelperClass) {
  let config;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = JSON.parse(raw);
  } catch (e) {
    // File not found or invalid JSON → silently use built-in rules
    return;
  }

  if (!config) return;

  // --- Feature 3: directMultimodal 模式（最高优先级） ---
  // 强制所有模型被视为多模态，图片直接以 image_url 传递
  if (config.directMultimodal === true) {
    MultimodalHelperClass.isMultimodalModel = function() { return true; };
    console.log('[MultimodalModel] directMultimodal enabled — all models treated as multimodal');
    return;
  }

  // --- Feature 1: isMultimodalModel() 配置化 ---
  const originalIsMultimodalModel = MultimodalHelperClass.isMultimodalModel;

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
    return originalIsMultimodalModel.call(this, modelName);
  };

  // --- Feature 2: 视觉模型路由配置化（核心功能） ---
  // 当 isMultimodalModel() 返回 false 时，使用 descriptionModel 指定的视觉模型
  if (config.descriptionModel && typeof config.descriptionModel === 'string' && config.descriptionModel.trim() !== '') {
    const userModel = config.descriptionModel.trim();
    const userConfig = config.descriptionModelConfig || {};

    // 覆盖 generateImageDescription — 使用用户配置的视觉模型
    MultimodalHelperClass.prototype.generateImageDescription = async function(base64Data, mimeType) {
      const cacheKey = this.generateCacheKey(base64Data, mimeType);
      const cached = MultimodalHelperClass.descriptionCache.get(cacheKey);
      if (cached) return cached;

      const prompt = this.createImageAnalysisPrompt();
      return this._requestWithModel(base64Data, mimeType, prompt, userModel, userConfig, cacheKey);
    };

    // 覆盖 generateImageDescriptionFromPrompt — 使用用户配置的视觉模型
    MultimodalHelperClass.prototype.generateImageDescriptionFromPrompt = async function(base64Data, mimeType, customPrompt) {
      const cacheKey = this.generateCacheKey(base64Data, mimeType, customPrompt);
      const cached = MultimodalHelperClass.descriptionCache.get(cacheKey);
      if (cached) return cached;

      return this._requestWithModel(base64Data, mimeType, customPrompt, userModel, userConfig, cacheKey);
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

    console.log(`[MultimodalModel] descriptionModel set to: ${userModel}`);
  }

  console.log('[MultimodalModel] Config loaded from', CONFIG_PATH);
}

module.exports = { load };
