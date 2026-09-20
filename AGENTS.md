# AGENTS.md — iFlowMods 项目上下文

## 项目概述

iFlowMods 是 iFlow CLI 的 Mod（补丁/插件）开发仓库。iFlow CLI 是一个基于 Node.js 的终端 AI 交互工具（v0.5.19），其核心源码以压缩混淆的 JavaScript 单文件形式分发（`iflow.js.original`，7723 行）。

本仓库的目的是**对 iFlow CLI 的硬编码逻辑进行解耦重构与兼容适配**，通过极小的源码改动（1 行逗号表达式插入或单函数体替换）+ 外部加载器模块 + 外部 JSON 配置文件的组合模式，将硬编码规则外置到用户可编辑的配置中，无需修改源码即可自定义模型行为。

当前仓库共 **11 个 MOD**，覆盖思考模式、多模态、流式、命令注册、API/模型切换、请求参数覆盖、输出/上下文 token 限制、特定模型流式适配、流式 tool_calls 重组修复等场景。

## 仓库结构

```
J:\git\iFlowMods\
├── iflow.js.original          ← iFlow CLI v0.5.19 原始源码（7723行，压缩混淆）
├── README.md                  ← 仓库总览文档
├── MOD提示词.txt               ← 交互历史中的用户提示词记录
├── .gitignore                 ← Git 忽略规则（排除 .original、dist、node_modules 等）
├── AGENTS.md                  ← 本文件
│
├── thinking-mode-refactor/    ← MOD: 思考模式配置化（patch, A2）
│   ├── code.js                ← 修改后的源码（插入 require 语句）
│   ├── mod.json               ← MOD 元数据（type: "patch"）
│   ├── thinking-model-loader.cjs ← 加载器（DSL 编译器 + registerModel 注入）
│   ├── thinking-models.json   ← 用户配置模板（DSL 规则）
│   ├── README.md              ← 使用文档
│   ├── thinking-mode-refactor-plan.md ← 实现规划文档
│   └── dist/                  ← 构建产物（.iflow-mod 安装包）
│
├── multimodal-image-refactor/ ← MOD: 多模态图片识别配置化（patch, _4）
│   ├── code.js / mod.json / README.md / multimodal-image-refactor-plan.md
│   ├── multimodal-model-loader.cjs ← 加载器（静态方法覆盖 + 实例方法覆盖）
│   ├── multimodal-models.json ← 用户配置模板（模型列表 + descriptionModel）
│   └── dist/
│
├── streaming-mode-refactor/   ← MOD: 流式响应配置化（patch, A2 monkey-patch）
│   ├── code.js / mod.json / README.md
│   ├── streaming-model-loader.cjs ← 加载器（monkey-patch configure*Request）
│   ├── streaming-models.json  ← 用户配置模板（forceNonStream + nonStreamModels）
│   └── dist/
│
├── command-api-refactor/      ← MOD: 命令注册 API 框架（replace）
│   ├── code.js / code_backup.js / mod.json / README.md / command-api-refactor-plan.md
│   ├── command-registry-loader.cjs ← 加载器（registerCommand/registerSlashCommand API）
│   └── dist/
│
├── api-command-refactor/      ← MOD: /api Profile 切换命令（patch, 依赖 command-api）
│   ├── code.js / mod.json / README.md / api-command-refactor-plan.md
│   ├── api-command-loader.cjs ← 加载器（/api 命令处理逻辑）
│   └── dist/
│
├── model-command-refactor/    ← MOD: /model 命令重构（replace）
│   ├── code.js / mod.json / README.md / model-command-refactor-plan.md
│   └── dist/
│
├── kimi-request-override-refactor/ ← MOD: Kimi 请求参数兼容层（patch, A2 monkey-patch）
│   ├── code.js / mod.json / README.md
│   ├── kimi-request-override-loader.cjs ← 加载器（set/delete/setIfMissing 请求字段）
│   ├── kimi-request-overrides.json ← 用户配置模板（默认适配 kimi-k3）
│   └── dist/
│
├── output-token-limit-refactor/ ← MOD: 输出 token 上限配置化（patch, A2 monkey-patch）
│   ├── code.js / mod.json / README.md
│   ├── output-token-limit-loader.cjs ← 加载器（defineProperty 劫持 max_new_tokens/max_tokens）
│   ├── output-token-limits.json ← 用户配置模板（floor/override 模式 + 模型正则）
│   └── dist/
│
├── context-window-refactor/   ← MOD: 上下文剩余百分比修复（patch, JR 函数体）
│   ├── code.js / mod.json / README.md
│   ├── context-window-loader.cjs ← settings.json 读取器（TTL + mtime 缓存）
│   └── dist/                  ← 注：无自有配置文件，复用 settings.json 的 tokensLimit
│
├── gpt54-stream-adapter/      ← MOD: gpt-5.4 专用流式解析（replace）
│   ├── code.js / mod.json / README.md
│   └── dist/                  ← 注：无 loader 与配置文件，逻辑内嵌 code.js
│
└── stream-toolcall-repair-refactor/ ← MOD: 流式 tool_calls 重组修复（patch, 方法体委托）
    ├── code.js / mod.json / README.md
    ├── stream-toolcall-repair-loader.cjs ← 加载器（修复版 SSE 解析器，委托接管）
    └── stream-toolcall-repair.json ← 用户配置模板（onParseError / repairTruncatedJson / modelPatterns）
```

## 核心设计模式

### "1行改动 + 外置模块 + 外置配置" 模式

多数 patch 类型 MOD 遵循相同的设计模式：

1. **源码改动**：在 `code.js` L950 的 `},A2=new Dqe});` 处插入逗号表达式
2. **加载器模块**：`.cjs` 文件放置到 iFlow 的 `core/` 目录，通过 `require()` 加载
3. **配置文件**：JSON 文件放置到 `~/.iflow/` 目录，用户按需编辑

**插入点原理**：L950 是 `Dqe`（ThinkingModelAdapter）类和 `_4`（MultimodalHelper）类的闭包结束位置。逗号表达式 `require('./xxx-loader.cjs').load(target)` 返回 `undefined`，不影响原有赋值和闭包结构。

> **例外**：`context-window-refactor` 不经过 L950，而是精准替换 `JR()` 函数体（插入 1 句）；`gpt54-stream-adapter` 为 `replace` 类型，逻辑内嵌，无 loader。

### monkey-patch configure*Request 模式

多个 patch MOD（streaming、kimi-request-override、output-token-limit）都通过 `load(A2)` 包装 `A2.configureThinkingRequest` 与 `A2.configureNonThinkingRequest` 两个方法，在请求体生成后按模型名匹配规则修改请求。它们各自独立包装同一对方法，互不冲突，可叠加共存。

### 方法体委托模式（stream-toolcall-repair）

当补丁目标（如 `parseStreamResponse`，OpenAIContentGenerator 类方法）位于模块闭包内、无法从 L950 作用域拿到类引用时，改为在**目标方法体开头**插入一句委托调用：

```javascript
async*parseStreamResponse(e){try{let __rep=require('./stream-toolcall-repair-loader.cjs');if(__rep&&typeof __rep.parseStreamResponse==="function"){let __gen=__rep.parseStreamResponse.call(this,e);if(__gen)return yield*__gen}}catch(__re){}if(!e.body)throw...
```

loader 导出与原型同名的实现（`this` 即原实例），返回 async generator 接管，或返回 `null` 让原始方法体继续执行。特点：不经过 L950、与其他 MOD 零冲突；loader 缺失/禁用时静默回退，code.js 单独使用也安全。

### ESM wrapper + 懒加载模式

部分 MOD（command-api-refactor、api-command-refactor、streaming-mode-refactor）需要在 `code.js` 顶部增加 ESM wrapper，使压缩混淆的 CommonJS 代码能在 ESM 环境下工作：

```javascript
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
globalThis.__filename = require('url').fileURLToPath(import.meta.url);
globalThis.__dirname = require('path').dirname(globalThis.__filename);
```

> 注：iFlow 原始 `code.js` 部分版本已自带 ESM wrapper（如 output-token-limit-refactor 说明其无需额外添加）。

同时如需避免阻塞，在 ESM wrapper 后添加懒加载入口：

```javascript
var __xxxLoaded__=!1;
global.__loadXxx=function(){
  if(__xxxLoaded__)return;
  __xxxLoaded__=!0;
  try{const l=require('./xxx-loader.cjs');if(l&&l.load)l.load()}
  catch(e){console.warn('[Xxx] Load error:',e.message)}
}
```

### 插入点格式

```
原始:     },A2=new Dqe});function Pln(){...
单MOD:    },A2=new Dqe,require('./loader.cjs').load(target)});function Pln(){...
双MOD:    },A2=new Dqe,require('./thinking-model-loader.cjs').load(A2),require('./multimodal-model-loader.cjs').load(_4)});
多MOD:    },A2=new Dqe,require('./thinking-model-loader.cjs').load(A2),require('./streaming-model-loader.cjs').load(A2),require('./output-token-limit-loader.cjs').load(A2),require('./kimi-request-override-loader.cjs').load(A2),require('./multimodal-model-loader.cjs').load(_4),require('./api-command-loader.cjs').load(A2)});
```

### MOD 类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `patch` | 最小改动，1行插入或单函数体替换 | thinking, multimodal, streaming, api-command, kimi-request-override, output-token-limit, context-window, stream-toolcall-repair |
| `replace` | 整体替换源码 | model-command, command-api, gpt54-stream-adapter |

## MOD 依赖关系

```
command-api-refactor (replace, 基础架构)
  └─ api-command-refactor (patch, 依赖前者提供 registerCommand API)

A2 系（共用 L950 插入点，monkey-patch 或 registerModel）:
  thinking-mode-refactor        (registerModel)
  streaming-mode-refactor       (configure*Request)
  kimi-request-override-refactor(configure*Request)
  output-token-limit-refactor   (configure*Request)
multimodal-image-refactor (patch, _4) — 独立加载目标

独立/replace:
  context-window-refactor (patch, JR 函数体，不经 L950)
  model-command-refactor  (replace)
  gpt54-stream-adapter    (replace, 逻辑内嵌)
  stream-toolcall-repair-refactor (patch, 方法体委托，不经 L950)
```

## 源码关键位置（iflow.js.original）

| 符号/类/函数 | 位置 | 说明 |
|---------|------|------|
| `_4` (MultimodalHelper) | L880 | 图片处理类，含 `isMultimodalModel()` 静态方法（50+ 硬编码模型） |
| `MOt()` | L880 | 输出 token 上限硬编码表（未知 8000 / qwen3 8192 / claude·gemini 65536 等） |
| `generateImageDescription()` | L880 内 | 视觉模型路由：iFlow→qwen3-vl-plus, Aone→Qwen2.5-VL-72B_aone, 其他→this.modelName |
| `A2` (Dqe singleton) | L950 | 思考模式适配器，含 `registerModel()`、`supportsThinking()`、`configure*Request()` |
| 插入点 `},A2=new Dqe});` | L950 | 多数 patch MOD 的统一插入位置 |
| `convertToOpenAIMessages()` | L956 | 图片处理核心分支；`p.max_new_tokens = MOt(...)` 赋值处 |
| `A2.configureThinkingRequest()` | L950 附近 | 请求拦截点：streaming / kimi / output-token 均 monkey-patch 此方法 |
| `A2.configureNonThinkingRequest()` | L950 附近 | 非思考模式请求拦截点 |
| `JR(model, settingsLimit)` | — | 上下文窗口计算函数；context-window-refactor 替换其函数体 |
| 状态栏显示 | L6217 | `JR(t)` 调用（未传 settingsLimit），context-window 修复的显示路径 |
| 压缩阈值 | L3358/L3436/L6475 | `JR(t, settingsLimit)` 调用（已传 tokensLimit） |
| `parseStreamResponse` | L961-L962 | OpenAI Content Generator 流式解析器；gpt54-adapter 新增旁路；stream-toolcall-repair 方法体委托接管 |

### 图片处理分支逻辑（convertToOpenAIMessages 内）

```javascript
// OpenAI Compatible API 模式 (!h && !g):
d.push({type:"image_url", image_url:{url:"data:..."}});  // 直接传图

// iFlow/Aone 模式:
if (_4.isMultimodalModel(n))
  d.push({type:"image_url", ...});  // 多模态模型，直接传图
else
  let A = await this.multimodalHelper.generateImageDescription(p.data, p.mimeType);
  d.push({type:"text", text:`[Image Description]: ${A}`});  // 生成文字描述
```

## 各 MOD 详解

### thinking-mode-refactor

**目标**：将 `Dqe`（A2）中硬编码的模型思考能力规则解耦到外部 JSON。

**加载目标**：`A2`，通过 `adapter.registerModel(regex, capability)` 注入。

**配置文件**：`~/.iflow/thinking-models.json`，`models` 数组每条规则含 `pattern`、`supportsThinking`、`supportedReasoningLevels`、`maxThinkingTokens`，以及 `thinkingRequest` / `nonThinkingRequest` DSL 块（5 种原语：set, delete, setNested, setConditional, setTemplate）。

**合并策略**：同 pattern 覆盖默认规则，异 pattern 追加。

### multimodal-image-refactor

**目标**：将 `_4`（MultimodalHelper）中硬编码的 50+ 视觉模型列表与视觉模型路由解耦到外部 JSON。仅适用 OpenAI Compatible API 登录模式。

**加载目标**：`_4`（类本身），静态方法覆盖 + 实例方法覆盖。

**三大功能**：isMultimodalModel() 配置化、视觉模型路由配置化（`descriptionModel`，核心）、directMultimodal 强制直传。

**匹配优先级**：directMultimodal > nonMultimodalModels > multimodalModels > multimodalPatterns > 原始硬编码。

### streaming-mode-refactor

**目标**：将流式响应硬编码行为配置化。monkey-patch `A2.configure*Request`，匹配规则则删除 `stream`/`stream_options` 字段。

**功能**：nonStreamModels 正则配置、forceNonStream 全局开关、Ctrl+S 运行时切换（非持久化）、TUI 状态栏 `streaming: on/off` 指示器。

**配置文件**：`~/.iflow/streaming-models.json`。匹配逻辑：forceNonStream > nonStreamModels 正则 > 默认流式。

### command-api-refactor

**目标**：命令注册 API 框架，使外部 MOD 通过全局 API 动态注册 TUI slash 命令和 CLI 命令。`type: "replace"`。

**核心 API**（global 上）：`registerSlashCommand` / `unregisterSlashCommand` / `getSlashCommands` / `registerCommand` / `unregisterCommand`。

**自动加载机制**：`load()` 中自动搜索并加载 `api-command-loader.cjs` 等依赖 loader。无依赖，其他 MOD 可依赖此框架。

### api-command-refactor

**目标**：添加 `/api` 命令，在 TUI 中切换 API Profile。**依赖** `com.command-api-refactor.mod`。

**功能**：`/api --list` 列出 Profile；`/api <name>` 切换；从 `~/.iflow/settings.json` 的 `apiProfiles` 读取；切换时更新 `currentApiProfile`/`baseUrl`/`apiKey`/`modelName`。仅支持选择，Profile 管理由外部工具 iFlow-Settings-Editor-GUI 负责。

### model-command-refactor

**目标**：重构 `/model` TUI 命令，支持从 OpenAI Compatible API 获取模型列表。

**核心变更**：`rYi` 组件 useEffect 新增 API 获取分支，优先从 `{baseUrl}/models` 获取，失败回退 `AJ()`/`rgt` 硬编码列表。`type: "replace"`。

### kimi-request-override-refactor

**目标**：为 Kimi 模型（OpenAI Compatible API）提供请求参数兼容层。默认适配 kimi-k3 的固定采样参数、thinking 清理与 `reasoning_effort` 默认值。

**加载目标**：`A2`，monkey-patch `configure*Request`，按模型名匹配后 `set` / `delete` / `setIfMissing` 请求字段。

**配置文件**：`~/.iflow/kimi-request-overrides.json`。默认规则匹配 `^kimi-k3`，set 采样参数、delete `thinking`、setIfMissing `reasoning_effort: max`。

**运行时 API**：`getKimiRequestOverrideConfig()` / `updateKimiRequestOverrideConfig()`。旧版 `forceTemperatureModels` 配置由 `normalizeLegacyConfig` 自动迁移。

### output-token-limit-refactor

**目标**：解决 `⚠️ 因 token 限制而截断响应` 问题。将 `MOt()` 硬编码输出上限表配置化，按模型正则自定义 `max_new_tokens` / `max_tokens`。

**加载目标**：`A2`，monkey-patch `configure*Request`。

**关键技术**：`p.max_new_tokens = A` 赋值发生在 `configure*Request` 之后，故用 `Object.defineProperty` 安装 getter/setter 劫持字段，吞掉后续赋值，`JSON.stringify` 时返回配置值。

**两种模式**：`floor`（默认，只调高不调低）/ `override`（强制覆盖）。

**配置文件**：`~/.iflow/output-token-limits.json`。匹配优先级：modelLimits 首个命中 > defaultLimit > 0（不劫持）。

**运行时 API**：`resolveOutputTokenLimit()` / `getOutputTokenLimitConfig()` / `updateOutputTokenLimitConfig()` / `reloadOutputTokenLimitConfig()`。

**注意**：生效上限受服务端模型实际最大输出能力约束。

### context-window-refactor（v2.0.0）

**目标**：修复状态栏 `上下文剩余 xx%` 显示 0% 或不准确的问题。让显示路径与压缩逻辑读取同一个 settings.json `tokensLimit` 字段。

**根因**：`JR(model, settingsLimit)` 设计上第二参数 >0 时优先，但只有压缩相关的 3 处调用（L3358/L3436/L6475）传了它，状态栏显示调用（L6217）没传，导致显示永远走硬编码表（未知模型兜底 128000）。

**修复方案**：精准替换 `JR()` 函数体，在 `if(e&&e>0)return e;` 之后插入 1 句读取 settings.json `tokensLimit`。零副作用：settings 缺失/未配置正数时行为与原始一致。**不经过 L950 插入点**。

**配置**：无自有配置文件，直接使用 `~/.iflow/settings.json` 的 `tokensLimit`（同时决定显示基准与压缩阈值）。

**运行时 API**：`readTokensLimit()`（5 秒 TTL + mtime 缓存，改后数秒生效，无需重启）。

### gpt54-stream-adapter

**目标**：为 `gpt-5.4`（OpenAI Compatible API）提供专用 SSE 流式解析，解决推理内容、思考签名、增量工具调用等字段无法被识别的兼容问题。`type: "replace"`，逻辑内嵌，无 loader/配置。

**核心变更**：新增 `parseGpt54CompatibleStream` 解析器，`generateContentStream` 中通过 `isGpt54StreamModel()`（正则 `/^gpt-5\.4(?:$|[-.:])/i`）路由：匹配走专用解析器，其余走原有 `parseStreamResponse`。

**处理字段**：`reasoning_content`→思考块、`signature`→thoughtSignature、`content`→文本块、`tool_calls`→functionCall、`finish_reason`→finishReason、`usage`→usageMetadata、`[DONE]` 终止。日志前缀 `[gpt54-stream-adapter]`。

### stream-toolcall-repair-refactor

**目标**：修复流式（SSE）`tool_calls` 增量重组缺陷（根因分析见 `empty-command-error-analysis.md`）：扩展强制 `--stream` 时，sensenova 等模型 `run_shell_command` 反复报「Internal Error: 命令不能为空」（TUI 非流式路径正常）。

**机制**：方法体委托（不经 L950）。在 `parseStreamResponse` 方法体开头插入 1 句委托调用；loader 接管时 `yield*` 委托给修复版解析器，loader 缺失/禁用/模型不匹配时静默回退原始实现。

**三项修复**（对应报告 §3.3 缺陷①②③）：
1. 重组按 OpenAI 规范 `index` 对齐（byIndex/byId 双映射），id 缺失分片正确归属，并行多调用分离；id/name 延迟到达补全 entry，部分卡每调用只发一次；无 id 时 finish 生成 `call_` 兜底 id
2. `JSON.parse` 失败默认 `drop` 坏调用（可选 `empty` 恢复旧的 `args:{}` 兜底）；arguments 空串属合法无参调用 → `{}`
3. 可选 `repairTruncatedJson` 本地闭合修复（闭合字符串/丢悬空键/补 null/补括号，仅 parse 失败后尝试）

**配置文件**：`~/.iflow/stream-toolcall-repair.json`（热重载 5 秒 TTL）。`enabled` / `modelPatterns`（空=全部模型）/ `onParseError` / `repairTruncatedJson` / `dropEmptyArgs` / `logDropped`。

**运行时 API**（global）：`getStreamToolCallRepairConfig()` / `updateStreamToolCallRepairConfig()` / `reloadStreamToolCallRepairConfig()` / `shouldRepairStreamModel()`。

**验证**：插入点唯一；code.js 往返替换与 original 逐字节一致；29 项模拟 SSE 单测通过（规范/无 id/并行交叉分片、坏 JSON 丢弃、截断修复、透传等价性）。日志前缀 `[StreamToolCallRepair]`。

## 兼容性矩阵

| MOD | 加载目标 | 类型 | 插入点 | 共存说明 |
|:---|:---|:---:|:---:|:---|
| thinking-mode-refactor | A2 (registerModel) | patch | L950 | ✓ 与所有 A2/其他系 |
| streaming-mode-refactor | A2 (configure*Request) | patch | L950 | ✓ 独立包装同一方法 |
| kimi-request-override-refactor | A2 (configure*Request) | patch | L950 | ✓ 独立包装同一方法 |
| output-token-limit-refactor | A2 (configure*Request) | patch | L950 | ✓ 独立包装同一方法 |
| multimodal-image-refactor | \_4 (class) | patch | L950 | ✓ 独立加载目标 |
| api-command-refactor | A2 + global API | patch | L950 | 需 command-api-refactor 前置 |
| context-window-refactor | JR 函数体 | patch | JR() | ✓ 不经 L950，与 output-token 正交互补 |
| command-api-refactor | (replace) | replace | — | 独立，可与 patch 共存 |
| model-command-refactor | (replace) | replace | — | 独立替换 |
| gpt54-stream-adapter | (replace, 内嵌) | replace | — | 独立替换 |
| stream-toolcall-repair-refactor | (方法体委托) | patch | parseStreamResponse | ✓ 不经 L950，与所有 patch/replace MOD 正交 |

> `replace` 类 MOD 之间因整体替换源码，通常互斥，同时只能启用一个（除非手动合并）。stream-toolcall-repair 的委托语句位于 `parseStreamResponse` 方法体内，若与整体替换该区域的 replace 型 MOD（gpt54-stream-adapter）合用，需手动把委托语句合并进替换版方法。

## 构建与安装

### 构建产物

每个 MOD 的 `dist/` 目录包含 `.iflow-mod` 安装包（如 `com.thinking-mode-refactor.mod-v1.0.0.iflow-mod`），可直接通过 iFlow Mod 管理器导入安装。

### 手动安装步骤

1. 将 `.cjs` 加载器文件复制到 iFlow 的 `iflow.js` 所在目录
2. 将 `.json` 配置文件复制到 `~/.iflow/` 目录
3. 对于 `replace` 类型 MOD，用 `code.js` 替换原 `iflow.js`
4. 对于 L950 型 `patch` MOD，找到 `},A2=new Dqe});`，插入对应的 require 语句
5. 对于 `context-window-refactor`，改为替换 `JR()` 函数体（见其 README）
6. 重启 iFlow

### mod.json includeMap

```json
{
  "loader.cjs": "core",      // 加载器 → iflow.js 所在目录
  "config.json": "~/.iflow"  // 配置 → 用户 home .iflow 目录
}
```

> `context-window-refactor` 仅 include loader（复用 settings.json）；`gpt54-stream-adapter` include 为空（逻辑内嵌）。

## 开发约定

- **源码改动极小**：patch 类型 MOD 仅修改 1 行或单函数体，不改变原有闭包结构
- **加载器模块**：使用 CommonJS（`.cjs`），导出 `{ load }` 函数（context-window 导出 `readTokensLimit`）
- **ESM wrapper**：`replace` 类型和部分 `patch` 类型需在 `code.js` 顶部添加 ESM import 以支持 `require()`（部分原始 code.js 已自带）
- **懒加载**：复杂 MOD 使用 `global.__loadXxx` 懒加载机制，避免启动阻塞
- **配置文件**：JSON 格式，放置在 `~/.iflow/`，加载失败时静默回退到默认规则
- **monkey-patch 约定**：修改 `configure*Request` 的 MOD 需保存原方法并调用，独立包装以支持叠加
- **defineProperty 劫持**：当目标字段在 configure 之后被赋值时，用 getter/setter 拦截（见 output-token-limit）
- **全局 API**：命令注册框架使用 `global.*` 暴露 API，供依赖 MOD 调用
- **变量命名**：源码用混淆名（`_4`, `A2`, `Dqe`, `MOt`, `JR`），加载器用语义名
- **错误处理**：配置不存在/语法错误 → 静默回退默认；正则非法 → console.warn + 子串匹配
- **日志**：使用 `[ThinkingModel]` / `[MultimodalModel]` / `[StreamingMode]` / `[CommandAPI]` / `[ApiCommand]` / `[KimiOverride]` / `[OutputTokenLimit]` / `[ContextWindow]` / `[gpt54-stream-adapter]` / `[StreamToolCallRepair]` 前缀

## 环境信息

- **平台**：Windows (win32 10.0.26200)
- **iFlow 版本**：0.5.19
- **Node.js**：iFlow 内置运行时
- **Python**：3.10.11
- **Git**：2.49.0
- **curl**：8.21.0
- **注意**：rg (ripgrep)、gh、wget、ffmpeg 未安装；搜索请使用 search_file_content 工具
