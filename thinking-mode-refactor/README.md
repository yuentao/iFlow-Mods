# Thinking Mode Refactor

将 iFlow 中硬编码的 12 条模型思考能力注册规则解耦到外部 JSON 配置文件，用户可编辑配置文件来添加、修改或禁用任意模型的思考能力配置，无需修改源码。

## 概述

在 iFlow 原版中，`ThinkingModelAdapter`（单例 A2）内部硬编码了 12 条模型规则，定义哪些模型支持思考模式（Thinking Mode）、推理级别、Max Tokens 及请求参数配置。当用户切换思考开关或选择不同的推理级别时，TUI 组件通过 `A2.supportsThinking(model)` 感知模型能力。

本 Mod 在 `A2` 初始化后插入一行加载代码，从 `~/.iflow/thinking-models.json` 读取用户定义的规则，通过 `registerModel()` 注入，用户规则与内置规则以 pattern 为 key 合并（同 pattern 覆盖，异 pattern 追加）。

## 架构

```
Layer 1: 状态管理层 (Config)
  ySe — thinkingModeEnabled 开关管理

Layer 2: 模型适配层 (ThinkingModelAdapter)
  Dqe (A2) — 注册模型规则，判断模型是否支持思考
  thinking-model-loader.cjs — 加载外部 JSON 配置并注入 A2

Layer 3: 意图分析层 (ThinkingAnalyzer)
  a1e — 分析输入文本，计算推理级别与思考配置
```

### 联动关系

TUI 组件通过 `A2.supportsThinking(model)` 感知模型能力，配置化规则注入后自动生效：

| TUI 组件 | 行为 | 生效方式 |
|----------|------|----------|
| `uio` (Tab 切换) | Tab 键切换思考开关 | `A2.supportsThinking(model)` |
| `P0e` (系统提示选择) | 选择思考/非思考提示词 | `A2.supportsThinking(model)` |
| `xzi` (思考块渲染) | 3 种显示模式 | 独立于模型规则 |

无需修改任何 TUI 代码。

## 文件说明

| 文件 | 说明 |
|------|------|
| `code.js` | 修改后的 iFlow 源码包。在 `A2 = new Dqe()` 后插入 `require('./thinking-model-loader.cjs').load(A2)`。 |
| `thinking-model-loader.cjs` | 配置加载器模块。读取 `~/.iflow/thinking-models.json`，将 DSL 规则编译为 `(req, config) => void` 函数并注册到 A2。 |
| `thinking-models.json` | 外部配置文件模板。包含 13 条示例规则（覆盖原版 12 条 + 新增 deepseek-v4-flash），支持 5 种 DSL 原语。 |
| `mod.json` | Mod 元数据，定义名称、版本、依赖、安装文件映射。 |
| `dist/com.thinking-mode-refactor.mod-v1.0.0.iflow-mod` | 构建产物，可直接通过 iFlow Mod 管理器安装。 |

## 安装

### 方式一：通过 iFlow Mod 管理器

1. 下载 `dist/com.thinking-mode-refactor.mod-v1.0.0.iflow-mod`
2. 在 iFlow 的 Mod 管理器中导入安装
3. 重启 iFlow

### 方式二：手动安装

1. 将 `thinking-model-loader.cjs` 复制到 iFlow 的 `iflow.js` 所在目录
2. 将 `thinking-models.json` 复制到 `~/.iflow/` 目录
3. 在 `iflow.js` 中找到 `A2 = new Dqe()`，在其后插入 `,require('./thinking-model-loader.cjs').load(A2)`
4. 重启 iFlow

## 配置说明

编辑 `~/.iflow/thinking-models.json` 文件，在 `models` 数组中添加或修改规则。

### 规则格式

```typescript
interface ModelRule {
  pattern: string;                    // 正则字符串，匹配模型名称（必填）
  supportsThinking: boolean;          // 是否支持思考模式（必填）
  supportedReasoningLevels?: string[]; // 支持的推理级别，默认 ["low","medium","high"]
  maxThinkingTokens?: number;         // 最大思考 Token 数，默认 0
  thinkingRequest?: DslBlock;         // 思考模式下的请求参数配置
  nonThinkingRequest?: DslBlock;      // 非思考模式下的请求参数配置
}
```

### DSL 原语

`DslBlock` 支持以下 5 种原语，可自由组合：

| 原语 | 说明 | 示例 |
|------|------|------|
| `set` | 设置顶层字段 | `{ "reasoning": true }` |
| `delete` | 删除顶层字段 | `["reasoning", "thinking_mode"]` |
| `setNested` | 点号路径设置嵌套字段 | `{ "thinking.type": "enabled" }` |
| `setConditional` | 条件满足时设置字段 | 按 `reasoningLevel` 动态设置 |
| `setTemplate` | 模板字符串 `{{var}}` 替换 | `{ "thinking.max_tokens": "{{maxTokens}}" }` |

### 示例规则

```json
{
  "models": [
    {
      "pattern": "^claude-3\\.5-sonnet",
      "supportsThinking": true,
      "maxThinkingTokens": 25000,
      "thinkingRequest": {
        "setNested": {
          "thinking.enabled": true
        },
        "setTemplate": {
          "thinking.max_tokens": "{{maxTokens}}",
          "thinking.reasoning_level": "{{reasoningLevel}}"
        }
      }
    },
    {
      "pattern": "qwen.*4b",
      "supportsThinking": false,
      "supportedReasoningLevels": [],
      "thinkingRequest": {
        "delete": ["thinking_mode", "reasoning"]
      }
    }
  ]
}
```

完整示例参见 `thinking-models.json` 文件。

## 合并策略

```
1. A2 = new Dqe() → initializeModelCapabilities() → 注册内置 12 条默认规则
2. load(A2) → 从 ~/.iflow/thinking-models.json 加载用户规则
3. registerModel 以 pattern.source 为 key 存入 Map
   同 pattern → 用户规则完全替换默认
   异 pattern → 追加到规则列表
```

## 边界防护

| 异常场景 | 处理方式 |
|----------|----------|
| 配置文件不存在 | 静默忽略，纯用默认规则 |
| JSON 语法错误 | 静默忽略 |
| pattern 正则非法 | console.warn + 跳过该条 |
| 缺少必填字段 | if 守卫 + console.warn + 跳过 |
| 无 thinkingRequest | 视为不支持 thinking |

## License

MIT