# 思考模式（Thinking Mode）重构规划

## 概述

将 `ThinkingModelAdapter（Dqe/单例 A2）`中硬编码的 12 条模型注册规则解耦到外部 JSON 配置文件中，用户可通过编辑配置文件来添加、修改或禁用任意模型的思考能力配置，无需修改源码。

## 一、当前架构分析

### 1.1 三层架构

```
Layer 1: 状态管理层（Config）
  ySe (Config) class
  - thinkingModeEnabled: boolean（默认 true）
  - getThinkingModeEnabled() / setThinkingModeEnabled(e)

Layer 2: 模型适配层（ThinkingModelAdapter）
  Dqe (单例 A2)
  - 12 条硬编码模型规则，通过 initializeModelCapabilities() 注册
  - supportsThinking(model) → boolean
  - configureThinkingRequest(model, req, config)
  - configureNonThinkingRequest(model, req)

Layer 3: 意图分析层（ThinkingAnalyzer）
  a1e (单例 _Mi / u1e)
  - analyzeInput(text) → "ultra"|"mega"|"hard"|"normal"|"none"
  - createThinkingConfig(text) → {intent, maxTokens, reasoningLevel, displayMode}
```

### 1.2 系统提示词选择逻辑（~L2623）

```javascript
b = A2.supportsThinking(model)         // A2 判断模型是否支持思考
A = config.getThinkingModeEnabled()    // 用户是否开启
y = b && A ? Nui(...) : Oui(...)       // 两者同时满足 → 思考提示词
```

### 1.3 请求配置逻辑（~L956）

```javascript
g?.thinking?.maxTokens > 0
  ? A2.configureThinkingRequest(p.model, p, g.thinking)
  : A2.configureNonThinkingRequest(p.model, p)
```

### 1.4 当前 12 条硬编码规则

| # | 匹配模式 | supportsThinking | 推理级别 | Max Tokens | thinking 配置 | non-thinking 配置 |
|---|---------|-----------------|---------|---------|-----------|--------------|
| 1 | `/^o1-(preview\|mini)/` | true | low/med/high | 32000 | `reasoning: true`（非 low 时） | - |
| 2 | `pH` (deepseek 系列) | true | low/med/high | 32000 | `reasoning: true`, `thinking_mode: true` | - |
| 3 | `/glm-4.7/` | true | low/med/high | 20000 | `chat_template_kwargs.enable_thinking: true` | `...enable_thinking: false` |
| 4 | `/glm-5/` | true | low/med/high | 20000 | `enable_thinking: true`, `thinking.type: enabled` | `enable_thinking: false`, `thinking.type: disabled` |
| 5 | `/glm-/` | true | low/med/high | 20000 | `chat_template_kwargs.enable_thinking: true` | - |
| 6 | `/^claude-3\.5-sonnet/i` | true | low/med/high | 25000 | `thinking.enabled: true`（含模板变量） | - |
| 7 | `fH` (claude 系列) | true | low/med/high | 20000 | `chat_template_kwargs.enable_thinking: true` | - |
| 8 | `/.*reasoning.*/` | true | low/med | 10000 | `reasoning: true` | - |
| 9 | `/^kimi-k2\.5/` | true | low/med/high | 32768 | `thinking.type: enabled` | `thinking.type: disabled` |
| 10 | `/.*thinking.*/` | true | low/med/high | 15000 | `thinking_mode: true` | - |
| 11 | `/qwen.*4b/i` | false | [] | - | 清除所有 thinking 参数 | - |
| 12 | `/mimo-/` | true | low/med/high | 20000 | `thinking.type: enabled` | - |

## 二、方案设计

### 2.1 核心思路

选定**方案 B（源码替换）**：直接修改 `code.js` 一行代码，在 `A2 = new Dqe()` 之后插入 `require('./thinking-model-loader.js').load(A2)`，加载外部 JSON 配置规则。

**关键洞察**：`A2.supportsThinking(model)` 是 TUI 与模型适配器之间的唯一定义契约。只要这个方法的返回值正确，TUI 所有组件（uio Tab 切换、P0e 系统提示选择、nfe spinner 等）自动正常工作，无需任何 UI 改动。

### 2.2 改动范围

| 文件 | 改动方式 | 改动量 |
|------|---------|--------|
| `code.js` (源码包) | 修改 1 处 | +30 字符 |
| `thinking-model-loader.js`（新建） | 新增文件 | ~140 行 |
| `~/.iflow/thinking-models.json`（新建） | 新增文件 | 用户按需创建 |

### 2.3 精确插入点

`code.js` L950 中的关键模式：

```
},A2=new Dqe});function Pln(){...
```

改为：

```
},A2=new Dqe,require('./thinking-model-loader.js').load(A2));function Pln(){...
```

改动原理：复用逗号表达式，`load()` 返回 `undefined`，不影响原有赋值和闭包结构。

### 2.4 加载器模块（thinking-model-loader.js）

职责：读取配置文件 → DSL 编译 → registerModel 注入。

```javascript
const path = require('path');
const fs = require('fs');
const CONFIG_PATH = path.join(require('os').homedir(), '.iflow', 'thinking-models.json');

function load(adapter) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) { return; } // 文件不存在或语法错误 → 静默忽略

  if (!config.models) return;

  for (const rule of config.models) {
    try {
      if (!rule.pattern || typeof rule.supportsThinking !== 'boolean') continue;
      const cap = {
        supportsThinking: rule.supportsThinking,
        supportedReasoningLevels: rule.supportedReasoningLevels || ['low', 'medium', 'high'],
        maxThinkingTokens: rule.maxThinkingTokens || 0,
      };
      if (rule.thinkingRequest) cap.configureRequest = compile(rule.thinkingRequest);
      if (rule.nonThinkingRequest) cap.configureNonThinkingRequest = compile(rule.nonThinkingRequest);
      adapter.registerModel(new RegExp(rule.pattern, 'i'), cap);
    } catch (e) {
      console.warn('[ThinkingModel] 规则加载失败:', rule.pattern, e.message);
    }
  }
}
```

DSL 编译器 `compile(dsl)` 支持 5 种原语（详见附录 A.2），将声明式 JSON 编译为 `(req, config) => void` 函数。

### 2.5 配置文件模板（~/.iflow/thinking-models.json）

示例规则：

```json
{
  "models": [
    {
      "pattern": "^o1-(preview|mini)",
      "supportsThinking": true,
      "maxThinkingTokens": 32000,
      "thinkingRequest": { "set": { "reasoning": true } },
      "nonThinkingRequest": { "delete": ["reasoning"] }
    },
    {
      "pattern": ".*thinking.*",
      "supportsThinking": true,
      "maxThinkingTokens": 15000,
      "thinkingRequest": { "set": { "thinking_mode": true } },
      "nonThinkingRequest": { "delete": ["thinking_mode"] }
    },
    {
      "pattern": "glm-5",
      "supportsThinking": true,
      "maxThinkingTokens": 20000,
      "thinkingRequest": {
        "set": { "enable_thinking": true },
        "setNested": {
          "chat_template_kwargs.enable_thinking": true,
          "thinking.type": "enabled"
        }
      },
      "nonThinkingRequest": {
        "set": { "enable_thinking": false },
        "setNested": {
          "chat_template_kwargs.enable_thinking": false,
          "thinking.type": "disabled"
        }
      }
    },
    {
      "pattern": "deepseek-v4-flash",
      "supportsThinking": true,
      "supportedReasoningLevels": ["low", "high"],
      "maxThinkingTokens": 65536,
      "thinkingRequest": {
        "setNested": {
          "thinking.type": "enabled",
          "thinking.reasoning_effort": "high"
        }
      },
      "nonThinkingRequest": {
        "setNested": {
          "thinking.type": "disabled"
        }
      }
    }
  ]
}
```

> `reasoning_effort` 字段的 DSL 支持：不同模型将此字段放在不同位置——SenseNova 6.7 Flash-Lite 放在顶层（`set` 即可设置），deepseek-v4-flash 放在 `thinking` 对象内（需用 `setNested` 设 `thinking.reasoning_effort`）。也可通过 `setConditional` 按用户选择的推理级别动态设置不同值，或用 `setTemplate` 绑定模板变量 `{{reasoningLevel}}`。DSL 原语组合可覆盖所有风格。

### 2.6 合并策略

```
1. A2 = new Dqe() → initializeModelCapabilities() → 注册 12 条默认规则
2. load(A2) → 从 ~/.iflow/thinking-models.json 加载用户规则
3. registerModel 以 pattern.source 为 key 存入 Map
   同 pattern → 用户规则完全替换默认
   异 pattern → 追加到规则列表
```

### 2.7 TUI 联动（零改动）

TUI 组件通过 `A2.supportsThinking(model)` 感知模型能力，配置化规则注入后自动生效：

| TUI 组件 | 行为 | 生效方式 |
|---------|------|---------|
| `uio` (Tab 切换) | Tab 键切换思考开关 | `A2.supportsThinking(model)` |
| `P0e` (系统提示选择) | 选择 Nui/Oui | `A2.supportsThinking(model)` |
| `xzi` (思考块渲染) | 3 种显示模式 | 独立于模型规则 |

无需修改任何 TUI 代码。

### 2.8 边界防护

| 异常场景 | 处理 |
|---------|------|
| 配置文件不存在 | `catch` → 静默忽略，纯用默认规则 |
| JSON 语法错误 | `catch` → 静默忽略 |
| pattern 正则非法 | `catch` → console.warn + 跳过该条 |
| 缺少必填字段 | `if` 守卫 → console.warn + 跳过 |
| 无 thinkingRequest | 被视为不支持 thinking |

---

## 附录：DSL 配置规范

### A.1 JSON Schema

```typescript
interface Config {
  models: ModelRule[];
}

interface ModelRule {
  pattern: string;               // 正则字符串，必填
  supportsThinking: boolean;      // 必填
  supportedReasoningLevels?: string[]; // 默认 ["low","medium","high"]
  maxThinkingTokens?: number;     // 默认 0
  thinkingRequest?: DslBlock;     // configureRequest 的 DSL
  nonThinkingRequest?: DslBlock;  // configureNonThinkingRequest 的 DSL
}

interface DslBlock {
  set?: Record<string, any>;            // 设置字段
  delete?: string[];                     // 删除字段
  setNested?: Record<string, any>;       // 点号路径设置深层对象
  setConditional?: ConditionalBlock[];   // 条件设置
  setTemplate?: Record<string, string>;  // 含模板变量的设置
}

interface ConditionalBlock {
  when: Record<string, Condition>;  // eq/neq/regex
  set: Record<string, any>;
}

interface Condition {
  eq?: any;
  neq?: any;
  regex?: string;
}
```

### A.2 DSL 原语说明

| 原语 | 说明 | 编译后行为 |
|------|------|-----------|
| `set` | 设置/覆写顶层字段 | `req[key] = value` |
| `delete` | 删除顶层字段 | `delete req[key]` |
| `setNested` | 点号路径设置嵌套字段 | `req.a.b.c = value`（自动创建中间对象） |
| `setConditional` | 条件满足时设置字段 | `if (matches(when, config)) req[key] = value` |
| `setTemplate` | 模板字符串（`{{var}}`）替换 | `req[key] = value.replace(/{{(\w+)}}/g, config[name])` |

### A.3 完整配置模板

参见 `~/.iflow/thinking-models.json` 示例，涵盖所有 12 条默认规则的 DSL 转换。

### A.4 DSL 编译器实现

`compile(dsl)` 返回 `(req, config) => void` 函数，体内部根据 hasXxx 守卫选择性执行对应原语逻辑。编译器在加载时预编译（检测 DSL 结构、缓存 hasXxx 标志），运行时仅做属性操作。

### A.5 当前 12 条规则的 DSL 对照表

| # | pattern | supportsThinking | DSL 示例 |
|---|---------|---------|---------|
| 1-2 | o1/deepseek | true | `thinkingRequest.set.reasoning = true; set.thinking_mode = true` |
| 3-5,7 | glm/claude | true | `thinkingRequest.setNested = {"chat_template_kwargs.enable_thinking": true}` |
| 6 | claude-3.5-sonnet | true | `thinkingRequest.setTemplate = {"thinking.max_tokens": "{{maxTokens}}"}` |
| 8-10,12 | reasoning/thinking/kimi/mimo | true | `thinkingRequest.set = {"reasoning": true}` 或 `thinkingRequest.setNested = {"thinking.type": "enabled"}` |
| 11 | qwen.*4b | false | `thinkingRequest.delete = ["thinking_mode", "reasoning"]` |