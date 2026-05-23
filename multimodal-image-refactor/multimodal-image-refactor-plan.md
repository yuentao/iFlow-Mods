# 多模态图片识别重构规划

## 概述

将 `MultimodalHelper（_4）` 中硬编码的 50+ 视觉模型列表和视觉模型路由配置解耦到外部 JSON 配置文件中，用户可通过编辑配置文件来添加、修改多模态模型识别规则和图片描述模型路由，无需修改源码。

**适用场景**：仅关注 OpenAI Compatible API 登录模式。

## 一、当前架构分析

### 1.1 OpenAI Compatible API 模式下的图片处理策略

**当前流程**：
```
用户输入图片 (imageReadTool)
    |
    v
convertToOpenAIMessages()
    |
    +-- isMultimodalModel(model) 返回 true
    |   → 图片直接以 image_url 格式传递给主模型API
    |   → {type:"image_url", image_url:{url:"data:"+mimeType+";base64,"+data}}
    |
    +-- isMultimodalModel(model) 返回 false
    |   → 调用 MultimodalHelper.generateImageDescription()
    |   → 使用视觉模型处理图片，生成文字描述
    |   → 以 [Image Description]: ... 文本形式传递给主模型
    |   → 视觉模型名: this.modelName（构造时传入，硬编码）
```

**重构后流程**：
```
用户输入图片 (imageReadTool)
    |
    v
convertToOpenAIMessages()
    |
    +-- isMultimodalModel(model) 返回 true（Feature 1 配置化）
    |   → 图片直接以 image_url 格式传递给主模型API
    |
    +-- isMultimodalModel(model) 返回 false
    |   → 调用 MultimodalHelper.generateImageDescription()
    |   → 使用 descriptionModel 配置的视觉模型处理图片
    |   → 视觉模型名: config.descriptionModel（来自 multimodal-models.json）
    |   → 以 [Image Description]: ... 文本形式传递给主模型
```

> **核心变化**：`isMultimodalModel` 返回 false 时，视觉模型名从硬编码的 `this.modelName` 改为从 `multimodal-models.json` 的 `descriptionModel` 字段读取。用户可自由指定任意支持视觉的模型（如 `qwen3-vl-plus`、`gpt-4o`、`gemini-2.5-flash` 等）。

### 1.2 MultimodalHelper 类（_4，L880附近）

```javascript
_4 = class MultimodalHelper {
  apiKey; baseUrl; modelName; isIFlowMode; isAoneMode;
  static descriptionCache = new Map;  // SHA256缓存，进程重启丢失

  constructor(apiKey, baseUrl, modelName, isIFlowMode=false, isAoneMode=false)
  // OpenAI Compatible API 模式: isIFlowMode=false, isAoneMode=false

  generateImageDescription(base64Data, mimeType) → 文字描述
    // OpenAI Compatible API 模式下，模型路由直接使用 this.modelName
    // （无 iFlow/Aone 的硬编码路由覆盖）

  generateImageDescriptionFromPrompt(base64Data, mimeType, customPrompt)
  generateContextAwareImageDescription(base64Data, mimeType, context)
  createContextAwarePrompt(context) → 增强提示词
  createImageAnalysisPrompt() → 基础提示词（中文，专业多模态AI分析专家）

  static isMultimodalModel(modelName) → boolean
    // 50+ 硬编码视觉模型名 + "vision"/"visual"/"vl" 模式匹配
}
```

### 1.3 isMultimodalModel() 硬编码模型列表（50+个）

```
Gemini 系列: gemini-2.5-flash-06-17, gemini-2.5-flash-lite-preview-06-17,
             gemini-2.5-flash-preview-05-20, gemini-2.5-flash-preview-04-17,
             gemini-2.5-pro-06-17, gemini-2.5-pro-preview-05-06,
             gemini-2.5-pro-03-25, gemini-2.5-pro-preview-06-05,
             gemini-2.0-flash, gemini-2.0-flash-thinking, gemini-2.0-flash-exp

Claude 系列: claude_opus4, claude3_opus, claude_sonnet4,
             claude37_sonnet, claude35_sonnet2, claude35_sonnet

OpenAI 系列: o3-pro-0610-global, o3-0416-global, o4-mini-0416-global,
             o3-mini-2025-01-31, o3-mini-0131-global,
             o1-preview-0912-global, o1-preview-0912,
             o1-mini-0912-global, o1-mini-0912,
             o1-2024-12-17, o1-1217-global, o1-1217,
             gpt-5, gpt-5-0807-global, gpt-5-mini,
             gpt-5-chat-0807-global, gpt-5-mini-0807-global, gpt-5-nano-0807-global,
             gpt-4o-1120-global, gpt-4o-0806-global, gpt-4o-0806,
             gpt-4o-0513-global, gpt-4o-0513-Batch, gpt-4o-0513,
             gpt-4o-0806-Batch, gpt-4o-mini-0718-global,
             gpt-4o-mini-0718, gpt-4o-mini-0718-Batch

Qwen 系列:  qwen-plus-latest-inc, qwen-plus-latest, qwen-plus,
             qwen-plus-safe, qwen2.5-vl-72b-instruct,
             qwen-vl-max, qwen3-vl-plus, Qwen-VL, qwen-vl-max-latest

其他:       kimi-k2.5, nova-lite-v1, nova-pro-v1

模式匹配:   包含 "vision" / "visual" / "vl" 的模型名也视为多模态
```

### 1.4 Content Generator 创建（OpenAI Compatible API 模式）

OpenAI Compatible API 登录模式下，Content Generator 直接使用用户配置的 baseUrl 和 apiKey，`multimodalModelName` 由 `contentGeneratorConfig` 传入（如果用户未配置则为空）。

### 1.5 i18n 中的 directMultimodal 标签

```
英文(L183): "directMultimodal":"direct multimodal"
中文(L307): "directMultimodal":"直接多模态"
```

出现在 `modelDialog` 上下文中（与 "recommend"、"fast" 并列），是模型选择对话框的分类标签。**目前仅作为 UI 标签存在，未找到对应的功能实现逻辑**。

### 1.6 imageReadTool 工具 i18n

```
pathNotAbsolute - 路径必须绝对
pathNotInWorkspace - 路径必须在工作区内
fileNotFound - 文件未找到
notImageFile - 非图片格式
emptyBase64 - base64数据为空
invalidBase64 - base64格式无效
invalidMimeType - MIME类型无效
multimodalHelperUnavailable - 多模态助手不可用
```

## 二、发现的问题

| # | 问题 | 严重程度 |
|---|------|---------|
| 1 | `isMultimodalModel()` 50+ 模型名硬编码，新增视觉模型需修改源码 | 高 |
| 2 | OpenAI Compatible API 模式下，图片描述模型名依赖构造时传入的 `modelName`，无法运行时配置 | 高 |
| 3 | `directMultimodal` 功能未实现，仅作为 UI 标签存在 | 中 |
| 4 | 非多模态模型总是被转换为文字描述，无法强制直接传递图片 | 中 |

## 三、方案设计

### 3.1 核心思路

借鉴 `thinking-mode-refactor` 的设计模式：**源码改动极小（1行），逻辑外置到独立模块，配置外置到用户目录**。

**关键洞察**：`_4.isMultimodalModel(model)` 是图片处理流程的核心判断函数。只要这个方法的返回值可以被外部配置覆盖，图片处理策略自动适配，无需修改 `convertToOpenAIMessages()` 或任何 UI 代码。

### 3.2 改动范围

| 文件 | 改动方式 | 改动量 |
|------|---------|--------|
| `code.js` (源码包) | 修改 1 处 | +40 字符 |
| `multimodal-model-loader.cjs`（新建） | 新增文件 | ~100 行 |
| `~/.iflow/multimodal-models.json`（新建） | 新增文件 | 用户按需创建 |

### 3.3 精确插入点

`code.js` L950 中的关键模式（与 thinking-mode-refactor 相同位置）：

```
},A2=new Dqe});function Pln(){...
```

改为：

```
},A2=new Dqe,require('./thinking-model-loader.cjs').load(A2),require('./multimodal-model-loader.cjs').load(_4));function Pln(){...
```

改动原理：复用逗号表达式，`load()` 返回 `undefined`，不影响原有赋值和闭包结构。`_4` 是 `MultimodalHelper` 类本身（不是实例），`load` 函数将修改其静态方法和属性。

> 注意：如果 thinking-mode-refactor MOD 已存在，两个 `require` 语句在同一个逗号表达式中插入，顺序无关。

### 3.4 加载器模块（multimodal-model-loader.cjs）

职责：读取配置文件 → 注册多模态模型规则 → 配置视觉模型路由 → 可选：启用 directMultimodal 模式。

```javascript
/**
 * multimodal-model-loader.cjs
 *
 * Loads multimodal model recognition rules from ~/.iflow/multimodal-models.json
 * and patches the MultimodalHelper (_4) class.
 *
 * Features:
 * 1. isMultimodalModel() 配置化 — 外部 JSON 覆盖硬编码模型列表
 * 2. 视觉模型路由配置化 — 用户指定图片描述使用的模型名
 * 3. directMultimodal 模式 — 强制所有模型直接传递图片
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_PATH = path.join(os.homedir(), '.iflow', 'multimodal-models.json');

function load(MultimodalHelperClass) {
  let config;
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    config = JSON.parse(raw);
  } catch (e) {
    // 文件不存在或语法错误 → 静默忽略，使用默认规则
    return;
  }

  if (!config) return;

  // --- Feature 3: directMultimodal 模式（最高优先级） ---
  if (config.directMultimodal === true) {
    MultimodalHelperClass.isMultimodalModel = function() { return true; };
    console.log('[MultimodalModel] directMultimodal enabled');
    return;
  }

  // --- Feature 1: isMultimodalModel() 配置化 ---
  const originalIsMultimodalModel = MultimodalHelperClass.isMultimodalModel;

  MultimodalHelperClass.isMultimodalModel = function(modelName) {
    const n = modelName.toLowerCase();

    // 1. 用户排除列表（优先级最高，显式排除）
    if (Array.isArray(config.nonMultimodalModels)) {
      if (config.nonMultimodalModels.some(m => n.includes(m.toLowerCase()))) {
        return false;
      }
    }

    // 2. 用户模型列表（contains 匹配）
    if (Array.isArray(config.multimodalModels)) {
      if (config.multimodalModels.some(m => n.includes(m.toLowerCase()))) {
        return true;
      }
    }

    // 3. 用户模式匹配规则
    if (Array.isArray(config.multimodalPatterns)) {
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

  // --- Feature 2: 视觉模型路由配置化 ---
  if (config.descriptionModel && typeof config.descriptionModel === 'string') {
    const userModel = config.descriptionModel;
    const userConfig = config.descriptionModelConfig || {};

    // 覆盖 generateImageDescription
    const originalGenerate = MultimodalHelperClass.prototype.generateImageDescription;
    MultimodalHelperClass.prototype.generateImageDescription = async function(base64Data, mimeType) {
      const n = this.generateCacheKey(base64Data, mimeType);
      const cached = MultimodalHelperClass.descriptionCache.get(n);
      if (cached) return cached;

      const prompt = this.createImageAnalysisPrompt();
      return this._requestWithModel(base64Data, mimeType, prompt, userModel, userConfig, n);
    };

    // 覆盖 generateImageDescriptionFromPrompt
    const originalFromPrompt = MultimodalHelperClass.prototype.generateImageDescriptionFromPrompt;
    MultimodalHelperClass.prototype.generateImageDescriptionFromPrompt = async function(base64Data, mimeType, customPrompt) {
      const n = this.generateCacheKey(base64Data, mimeType, customPrompt);
      const cached = MultimodalHelperClass.descriptionCache.get(n);
      if (cached) return cached;

      return this._requestWithModel(base64Data, mimeType, customPrompt, userModel, userConfig, n);
    };

    // 通用请求方法（替代原方法中的硬编码路由逻辑）
    MultimodalHelperClass.prototype._requestWithModel = async function(base64Data, mimeType, prompt, model, cfg, cacheKey) {
      const body = {
        model,
        messages: [{ role: 'user', content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Data}` } }
        ]}],
        temperature: cfg.temperature ?? 0.1,
        max_tokens: cfg.max_tokens ?? 2000
      };

      const url = (this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl) + '/chat/completions';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}`, 'user-agent': 'iFlow-Cli-MultimodalHelper' },
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API error! status: ${res.status}, body: ${text} TraceID: ${res.headers.get('eagleeye-traceid')}`);
      }

      let json;
      try { json = await res.json(); } catch { throw new Error(`Response format error. TraceID: ${res.headers.get('eagleeye-traceid')}`); }
      if (json.msg && json.msg.includes('invalid apiKey')) throw new Error('Invalid API key provided for model');

      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error('No description generated by model');

      const result = content.trim();
      MultimodalHelperClass.descriptionCache.set(cacheKey, result);
      return result;
    };
  }

  console.log('[MultimodalModel] Loaded config from', CONFIG_PATH);
}

module.exports = { load };
```

### 3.5 配置文件模板（~/.iflow/multimodal-models.json）

```json
{
  "description": "Multimodal model recognition rules config (OpenAI Compatible API mode)",
  "version": 1,

  "directMultimodal": false,

  "multimodalModels": [
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "claude_opus4",
    "claude_sonnet4",
    "claude37_sonnet",
    "claude35_sonnet2",
    "claude35_sonnet",
    "o3-pro",
    "o3",
    "o4-mini",
    "o3-mini",
    "o1-preview",
    "o1-mini",
    "o1",
    "gpt-5",
    "gpt-5-mini",
    "gpt-4o",
    "gpt-4o-mini",
    "qwen-plus-latest-inc",
    "qwen-plus-latest",
    "qwen-plus",
    "qwen2.5-vl-72b-instruct",
    "qwen-vl-max",
    "qwen3-vl-plus",
    "qwen-vl-max-latest",
    "kimi-k2.5",
    "nova-lite-v1",
    "nova-pro-v1"
  ],

  "multimodalPatterns": [
    "vision",
    "visual",
    "vl"
  ],

  "nonMultimodalModels": [],

  "descriptionModel": "",

  "descriptionModelConfig": {
    "temperature": 0.1,
    "max_tokens": 2000
  }
}
```

> `descriptionModel` 为空字符串时，回退到原始逻辑（使用构造时传入的 `this.modelName`）。

### 3.6 合并策略

```
1. _4.isMultimodalModel() 原始方法 → 硬编码 50+ 模型列表 + vision/visual/vl 模式匹配
2. load(_4) → 从 ~/.iflow/multimodal-models.json 加载用户配置
3. 新 isMultimodalModel() 判断顺序：
   a. directMultimodal=true → 直接返回 true（最高优先级，短路退出）
   b. nonMultimodalModels 排除列表 → 显式排除（优先级最高）
   c. multimodalModels 用户列表 → contains 匹配
   d. multimodalPatterns 用户正则 → 模式匹配
   e. 回退到原始方法（保留所有硬编码规则）
```

### 3.7 视觉模型路由配置化（核心功能）

**问题**：当 `isMultimodalModel()` 返回 false 时，`generateImageDescription()` 使用 `this.modelName`（构造时传入）作为视觉模型名。如果构造时传入的模型本身不支持视觉，API 调用会失败。

**解决**：通过 `descriptionModel` 字段，让用户显式指定一个支持视觉的模型来处理图片。

**数据流**：
```
isMultimodalModel(model) === false
    ↓
convertToOpenAIMessages() 进入 else 分支
    ↓
调用 this.multimodalHelper.generateImageDescription(data, mimeType)
    ↓
generateImageDescription() 内部：
    原始: let a = this.modelName;  // 可能是不支持视觉的模型
    新增: let a = config.descriptionModel;  // 用户配置的视觉模型
    ↓
使用视觉模型 a 调用 /chat/completions API
    ↓
返回文字描述 → [Image Description]: ...
    ↓
文字描述作为上下文传递给主模型
```

**配置示例**：
```json
{
  "descriptionModel": "qwen3-vl-plus"
}
```
- 设置后：所有非多模态模型的图片处理都使用 `qwen3-vl-plus`
- 未设置（空字符串）：回退到 `this.modelName`（原始行为）

**注意**：`descriptionModel` 指定的模型必须与当前 API 端点兼容（同一 baseUrl/apiKey 下可用）。

### 3.8 TUI 联动（零改动）

| TUI 组件 | 行为 | 生效方式 |
|---------|------|---------|
| `convertToOpenAIMessages()` | 图片处理策略 | `_4.isMultimodalModel(model)` |
| `imageReadTool` | 图片读取与描述生成 | `MultimodalHelper` 实例方法 |
| `modelDialog` | "直接多模态"标签 | 已有 UI，无需改动 |

无需修改任何 TUI 或消息处理代码。

### 3.9 边界防护

| 异常场景 | 处理 |
|---------|------|
| 配置文件不存在 | `catch` → 静默忽略，纯用默认规则 |
| JSON 语法错误 | `catch` → 静默忽略 |
| multimodalPatterns 正则非法 | `catch` → console.warn + 跳过该条 |
| descriptionModel 为空字符串 | 回退到 `this.modelName`（原始行为） |
| directMultimodal=true + nonMultimodalModels 有内容 | directMultimodal 优先（所有模型都返回 true） |
| 配置文件 version 不匹配 | 未来可做版本检查，当前忽略 |

## 四、MOD 配置（mod.json）

```json
{
  "id": "com.multimodal-image-refactor.mod",
  "name": "multimodal-image-refactor",
  "version": "1.0.0",
  "type": "patch",
  "description": "将 iFlow 中硬编码的 50+ 多模态模型识别列表和视觉模型路由配置解耦到外部 JSON 配置文件中，用户可通过编辑配置文件来添加、修改多模态模型识别规则和图片描述模型路由，无需修改源码。支持 directMultimodal 模式强制所有模型直接传递图片。",
  "author": "yuantao",
  "category": "功能增强",
  "iflowVersion": "0.5.19",
  "iflowVersionConstraint": "0.5.19",
  "icon": "🖼️",
  "tags": ["multimodal", "vision", "image"],
  "license": "MIT",
  "include": [
    "multimodal-model-loader.cjs",
    "multimodal-models.json"
  ],
  "includeMap": {
    "multimodal-model-loader.cjs": "core",
    "multimodal-models.json": "~/.iflow"
  }
}
```

## 五、与 thinking-mode-refactor 的兼容性

两个 MOD 都在 `code.js` L950 的同一位置插入 `require` 语句：

```
原始: },A2=new Dqe});function Pln(){...

thinking-mode-refactor:
},A2=new Dqe,require('./thinking-model-loader.cjs').load(A2));function Pln(){...

multimodal-image-refactor（独立安装）:
},A2=new Dqe,require('./multimodal-model-loader.cjs').load(_4));function Pln(){...

两者同时安装:
},A2=new Dqe,require('./thinking-model-loader.cjs').load(A2),require('./multimodal-model-loader.cjs').load(_4));function Pln(){...
```

由于两者使用不同的加载目标（`A2` vs `_4`），互不干扰，可安全共存。

## 六、实现优先级

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | isMultimodalModel() 配置化 | 核心功能，解决硬编码问题 |
| P0 | 视觉模型路由配置化 | 解决图片描述模型硬编码问题 |
| P1 | directMultimodal 模式 | 实现已有 UI 标签对应的功能 |
| P2 | multimodalPatterns 正则支持 | 灵活的模式匹配规则 |
| P2 | nonMultimodalModels 排除列表 | 显式排除误判模型 |
| P3 | descriptionModelConfig 参数配置 | temperature/max_tokens 可配置 |

## 七、附录：DSL 配置规范

### A.1 JSON Schema

```typescript
interface MultimodalConfig {
  description?: string;
  version?: number;
  
  // 全局开关
  directMultimodal?: boolean;  // 默认 false
  
  // 模型识别规则
  multimodalModels?: string[];      // 包含匹配的模型名列表
  multimodalPatterns?: string[];     // 正则模式列表
  nonMultimodalModels?: string[];    // 显式排除列表
  
  // 图片描述模型配置
  descriptionModel?: string;         // 用于图片描述的视觉模型名
  descriptionModelConfig?: {
    temperature?: number;            // 默认 0.1
    max_tokens?: number;             // 默认 2000
  };
}
```

### A.2 匹配优先级

```
1. directMultimodal=true → 所有模型返回 true（最高优先级）
2. nonMultimodalModels → 显式排除（覆盖其他所有规则）
3. multimodalModels → 包含匹配
4. multimodalPatterns → 正则匹配
5. 原始硬编码规则 → 回退（最低优先级）
```

### A.3 完整配置模板

参见 `~/.iflow/multimodal-models.json` 示例，涵盖所有 50+ 默认模型的简化列表（使用模糊匹配而非精确列举）。

### A.4 与 thinking-mode-refactor 的设计对比

| 维度 | thinking-mode-refactor | multimodal-image-refactor |
|------|----------------------|--------------------------|
| 加载目标 | `A2` (Dqe 实例) | `_4` (MultimodalHelper 类) |
| 修改方式 | `registerModel()` 注入 | 静态方法覆盖 + 实例方法覆盖 |
| 合并策略 | 同 pattern 替换，异 pattern 追加 | 用户列表 + 回退原始方法 |
| DSL 编译 | 需要（5种原语） | 不需要（仅列表匹配 + 正则） |
| 配置复杂度 | 高（每条规则含 DSL 块） | 低（仅列表 + 简单字段） |
| 适用登录模式 | 所有模式 | OpenAI Compatible API |