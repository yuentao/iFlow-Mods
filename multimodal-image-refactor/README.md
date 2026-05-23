# Multimodal Image Refactor

将 iFlow 中硬编码的 50+ 多模态模型识别列表和视觉模型路由配置解耦到外部 JSON 配置文件，用户可编辑配置文件来添加、修改多模态模型识别规则和图片描述模型路由，无需修改源码。

## 概述

在 iFlow 原版中，`MultimodalHelper`（类 `_4`）内部硬编码了 50+ 视觉模型名列表，并通过 `isMultimodalModel()` 静态方法判断当前模型是否支持直接传递图片。当模型不支持视觉时，`generateImageDescription()` 使用构造时传入的 `modelName` 作为视觉模型来生成图片文字描述——如果该模型本身不支持视觉，API 调用会失败。

本 Mod 在 `_4` 类定义后插入一行加载代码，从 `~/.iflow/multimodal-models.json` 读取用户配置，实现三个核心功能：

1. **isMultimodalModel() 配置化** — 用户可通过外部 JSON 覆盖硬编码模型列表
2. **视觉模型路由配置化** — 用户可指定 `descriptionModel`，当 `isMultimodalModel()` 返回 false 时，使用该配置的视觉模型处理图片
3. **directMultimodal 模式** — 强制所有模型直接传递图片（实现已有 UI 标签对应的功能）

**适用场景**：仅关注 OpenAI Compatible API 登录模式。

## 架构

```
Layer 1: 图片处理层 (MultimodalHelper)
  _4 — 判断模型是否多模态，生成图片文字描述
  multimodal-model-loader.cjs — 加载外部 JSON 配置并覆盖 _4 的静态方法和实例方法

Layer 2: 消息转换层 (convertToOpenAIMessages)
  根据 isMultimodalModel() 返回值决定图片传递方式：
  - true → 图片直接以 image_url 格式传递给主模型
  - false → 调用 descriptionModel 配置的视觉模型生成文字描述
```

### 联动关系

TUI 组件通过 `_4.isMultimodalModel(model)` 感知模型视觉能力，配置化规则注入后自动生效：

| TUI 组件 | 行为 | 生效方式 |
|----------|------|----------|
| `convertToOpenAIMessages()` | 图片处理策略 | `_4.isMultimodalModel(model)` |
| `imageReadTool` | 图片读取与描述生成 | `MultimodalHelper` 实例方法 |
| `modelDialog` | "直接多模态"标签 | 已有 UI，无需改动 |

无需修改任何 TUI 或消息处理代码。

## 文件说明

| 文件 | 说明 |
|------|------|
| `code.js` | 修改后的 iFlow 源码包。在 `A2 = new Dqe()` 后插入 `,require('./multimodal-model-loader.cjs').load(_4)`。 |
| `multimodal-model-loader.cjs` | 配置加载器模块。读取 `~/.iflow/multimodal-models.json`，覆盖 `_4` 的静态方法 `isMultimodalModel` 和实例方法 `generateImageDescription` 等。 |
| `multimodal-models.json` | 外部配置文件模板。包含模型识别列表、模式匹配规则、视觉模型路由配置。 |
| `mod.json` | Mod 元数据，定义名称、版本、依赖、安装文件映射。 |

## 安装

### 方式一：通过 iFlow Mod 管理器

1. 构建 Mod 包
2. 在 iFlow 的 Mod 管理器中导入安装
3. 重启 iFlow

### 方式二：手动安装

1. 将 `multimodal-model-loader.cjs` 复制到 iFlow 的 `iflow.js` 所在目录
2. 将 `multimodal-models.json` 复制到 `~/.iflow/` 目录
3. 在 `iflow.js` 中找到 `},A2=new Dqe});`，将其改为 `},A2=new Dqe,require('./multimodal-model-loader.cjs').load(_4)});`
4. 重启 iFlow

## 配置说明

编辑 `~/.iflow/multimodal-models.json` 文件。

### 配置格式

```typescript
interface MultimodalConfig {
  description?: string;
  version?: number;

  // 全局开关
  directMultimodal?: boolean;          // 默认 false，强制所有模型直接传递图片

  // 模型识别规则
  multimodalModels?: string[];          // 包含匹配的模型名列表
  multimodalPatterns?: string[];        // 正则模式列表
  nonMultimodalModels?: string[];       // 显式排除列表

  // 图片描述模型配置
  descriptionModel?: string;            // 用于图片描述的视觉模型名
  descriptionModelConfig?: {
    temperature?: number;               // 默认 0.1
    max_tokens?: number;                // 默认 2000
  };
}
```

### 功能详解

#### Feature 1: isMultimodalModel() 配置化

通过 `multimodalModels`、`multimodalPatterns`、`nonMultimodalModels` 三个字段覆盖硬编码模型列表：

- **multimodalModels** — 包含匹配列表，模型名包含列表中任一字符串即视为多模态
- **multimodalPatterns** — 正则模式列表，模型名匹配任一正则即视为多模态
- **nonMultimodalModels** — 显式排除列表，优先级最高，模型名包含列表中任一字符串即排除

匹配优先级：`nonMultimodalModels` > `multimodalModels` > `multimodalPatterns` > 原始硬编码规则

#### Feature 2: 视觉模型路由配置化（核心功能）

当 `isMultimodalModel()` 返回 false 时，图片处理流程：

```
isMultimodalModel(model) === false
    ↓
调用 MultimodalHelper.generateImageDescription(data, mimeType)
    ↓
使用 descriptionModel 配置的视觉模型处理图片
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

#### Feature 3: directMultimodal 模式

```json
{
  "directMultimodal": true
}
```

设置后 `isMultimodalModel()` 对所有模型返回 true，图片直接以 `image_url` 格式传递，不再生成文字描述。适用于所有模型实际都支持视觉的场景（如某些 API 代理）。

### 完整配置示例

```json
{
  "description": "Multimodal model recognition rules config",
  "version": 1,
  "directMultimodal": false,
  "multimodalModels": [
    "gemini-2.5-flash",
    "gpt-4o",
    "qwen3-vl-plus"
  ],
  "multimodalPatterns": [
    "vision",
    "visual",
    "vl"
  ],
  "nonMultimodalModels": [],
  "descriptionModel": "qwen3-vl-plus",
  "descriptionModelConfig": {
    "temperature": 0.1,
    "max_tokens": 2000
  }
}
```

## 合并策略

```
1. _4.isMultimodalModel() 原始方法 → 硬编码 50+ 模型列表 + vision/visual/vl 模式匹配
2. load(_4) → 从 ~/.iflow/multimodal-models.json 加载用户配置
3. 新 isMultimodalModel() 判断顺序：
   a. directMultimodal=true → 直接返回 true（最高优先级，短路退出）
   b. nonMultimodalModels 排除列表 → 显式排除
   c. multimodalModels 用户列表 → contains 匹配
   d. multimodalPatterns 用户正则 → 模式匹配
   e. 回退到原始方法（保留所有硬编码规则）
```

## 与 thinking-mode-refactor 的兼容性

两个 Mod 在 `iflow.js` 同一位置插入 `require` 语句，使用不同的加载目标：

```
原始: },A2=new Dqe});function Pln(){...

thinking-mode-refactor:
},A2=new Dqe,require('./thinking-model-loader.cjs').load(A2)});function Pln(){...

multimodal-image-refactor（独立安装）:
},A2=new Dqe,require('./multimodal-model-loader.cjs').load(_4)});function Pln(){...

两者同时安装:
},A2=new Dqe,require('./thinking-model-loader.cjs').load(A2),require('./multimodal-model-loader.cjs').load(_4)});function Pln(){...
```

`A2`（ThinkingModelAdapter）和 `_4`（MultimodalHelper）是不同的对象，互不干扰，可安全共存。

## 边界防护

| 异常场景 | 处理方式 |
|----------|----------|
| 配置文件不存在 | 静默忽略，纯用默认规则 |
| JSON 语法错误 | 静默忽略 |
| multimodalPatterns 正则非法 | console.warn + 跳过该条 |
| descriptionModel 为空字符串 | 回退到 `this.modelName`（原始行为） |
| directMultimodal=true + nonMultimodalModels 有内容 | directMultimodal 优先（所有模型都返回 true） |

## License

MIT