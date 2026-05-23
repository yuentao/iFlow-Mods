# AGENTS.md — iFlowMods 项目上下文

## 项目概述

iFlowMods 是 iFlow CLI 的 Mod（补丁/插件）开发仓库。iFlow CLI 是一个基于 Node.js 的终端 AI 交互工具（v0.5.19），其核心源码以压缩混淆的 JavaScript 单文件形式分发（`iflow.js.original`，7723 行）。

本仓库的目的是**对 iFlow CLI 的硬编码逻辑进行解耦重构**，通过极小的源码改动（1 行逗号表达式插入）+ 外部加载器模块 + 外部 JSON 配置文件的组合模式，将硬编码规则外置到用户可编辑的配置中，无需修改源码即可自定义模型行为。

## 仓库结构

```
J:\git\iFlowMods\
├── iflow.js.original          ← iFlow CLI v0.5.19 原始源码（7723行，压缩混淆）
├── MOD提示词.txt               ← 交互历史中的用户提示词记录
├── .gitignore                 ← Git 忽略规则（排除 .original、dist、node_modules 等）
├── AGENTS.md                  ← 本文件
│
├── thinking-mode-refactor/    ← MOD: 思考模式配置化（已完成）
│   ├── code.js                ← 修改后的源码（插入 require 语句）
│   ├── mod.json               ← MOD 元数据（type: "patch"）
│   ├── thinking-model-loader.cjs ← 加载器模块（DSL 编译器 + registerModel 注入）
│   ├── thinking-models.json   ← 用户配置模板（13 条规则，5 种 DSL 原语）
│   ├── README.md              ← 使用文档
│   ├── thinking-mode-refactor-plan.md ← 实现规划文档
│   └── dist/                  ← 构建产物（.iflow-mod 安装包）
│
├── multimodal-image-refactor/ ← MOD: 多模态图片识别配置化（已完成）
│   ├── code.js                ← 修改后的源码（插入 require 语句）
│   ├── mod.json               ← MOD 元数据（type: "patch"）
│   ├── multimodal-model-loader.cjs ← 加载器模块（静态方法覆盖 + 实例方法覆盖）
│   ├── multimodal-models.json ← 用户配置模板（模型列表 + descriptionModel）
│   ├── README.md              ← 使用文档
│   └── multimodal-image-refactor-plan.md ← 实现规划文档
│
└── model-command-refactor/    ← MOD: /model 命令重构（已完成）
    ├── code.js                ← 修改后的源码（type: "replace"，整体替换）
    ├── mod.json               ← MOD 元数据
    ├── README.md              ← /model 命令架构文档
    ├── model-command-refactor-plan.md ← 实现规划文档
    └── dist/                  ← 构建产物（.iflow-mod 安装包）
```

## 核心设计模式

### "1行改动 + 外置模块 + 外置配置" 模式

所有 patch 类型 MOD 遵循相同的设计模式：

1. **源码改动**：在 `code.js` L950 的 `},A2=new Dqe});` 处插入逗号表达式
2. **加载器模块**：`.cjs` 文件放置到 iFlow 的 `core/` 目录，通过 `require()` 加载
3. **配置文件**：JSON 文件放置到 `~/.iflow/` 目录，用户按需编辑

**插入点原理**：L950 是 `Dqe`（ThinkingModelAdapter）类和 `_4`（MultimodalHelper）类的闭包结束位置。逗号表达式 `require('./xxx-loader.cjs').load(target)` 返回 `undefined`，不影响原有赋值和闭包结构。

### 插入点格式

```
原始:   },A2=new Dqe});function Pln(){...
单MOD:  },A2=new Dqe,require('./loader.cjs').load(target)});function Pln(){...
双MOD:  },A2=new Dqe,require('./thinking-model-loader.cjs').load(A2),require('./multimodal-model-loader.cjs').load(_4)});function Pln(){...
```

### MOD 类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `patch` | 最小改动，1行插入 | thinking-mode-refactor, multimodal-image-refactor |
| `replace` | 整体替换源码 | model-command-refactor |

## 源码关键位置（iflow.js.original）

| 符号/类 | 位置 | 说明 |
|---------|------|------|
| `_4` (MultimodalHelper) | L880 | 图片处理类，含 `isMultimodalModel()` 静态方法（50+ 硬编码模型） |
| `A2` (Dqe singleton) | L950 | 思考模式适配器，含 `registerModel()` 和 `supportsThinking()` |
| `convertToOpenAIMessages()` | L956 | 图片处理核心分支：`isMultimodalModel()` → 直接传图 or 生成描述 |
| `generateImageDescription()` | L880 内 | 视觉模型路由：iFlow→qwen3-vl-plus, Aone→Qwen2.5-VL-72B_aone, 其他→this.modelName |
| 插入点 `},A2=new Dqe});` | L950 | 所有 patch MOD 的统一插入位置 |

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

**目标**：将 `Dqe`（A2）中硬编码的 12 条模型思考能力规则解耦到外部 JSON。

**加载目标**：`A2`（Dqe 实例），通过 `adapter.registerModel(regex, capability)` 注入。

**配置文件**：`~/.iflow/thinking-models.json`，包含 `models` 数组，每条规则含：
- `pattern`（正则）、`supportsThinking`、`supportedReasoningLevels`、`maxThinkingTokens`
- `thinkingRequest` DSL 块（5 种原语：set, delete, setNested, setConditional, setTemplate）
- `nonThinkingRequest` DSL 块

**合并策略**：同 pattern 覆盖默认规则，异 pattern 追加。

### multimodal-image-refactor

**目标**：将 `_4`（MultimodalHelper）中硬编码的 50+ 视觉模型列表和视觉模型路由解耦到外部 JSON。

**适用场景**：仅 OpenAI Compatible API 登录模式。

**加载目标**：`_4`（MultimodalHelper 类本身），通过静态方法覆盖 + 实例方法覆盖。

**三大功能**：
1. **isMultimodalModel() 配置化** — `multimodalModels`/`multimodalPatterns`/`nonMultimodalModels` 覆盖硬编码列表
2. **视觉模型路由配置化** — `descriptionModel` 指定图片描述使用的视觉模型（核心功能）
3. **directMultimodal 模式** — 强制所有模型直接传递图片

**配置文件**：`~/.iflow/multimodal-models.json`

**匹配优先级**：directMultimodal > nonMultimodalModels > multimodalModels > multimodalPatterns > 原始硬编码

### model-command-refactor

**目标**：重构 `/model` TUI 命令，支持从 OpenAI Compatible API 获取模型列表。

**核心变更**：在 `rYi` 组件的 useEffect 中新增 API 获取分支，优先从 `{baseUrl}/models` 获取模型列表，失败时回退到 `AJ()`/`rgt` 硬编码列表。

## 兼容性

thinking-mode-refactor 和 multimodal-image-refactor 使用不同的加载目标（`A2` vs `_4`），在同一插入点通过逗号表达式共存，互不干扰。两者同时安装时的 code.js 格式：

```
},A2=new Dqe,require('./thinking-model-loader.cjs').load(A2),require('./multimodal-model-loader.cjs').load(_4)});function Pln(){...
```

## 构建与安装

### 构建产物

每个 MOD 的 `dist/` 目录包含 `.iflow-mod` 安装包（如 `com.thinking-mode-refactor.mod-v1.0.0.iflow-mod`），可直接通过 iFlow Mod 管理器导入安装。

### 手动安装步骤

1. 将 `.cjs` 加载器文件复制到 iFlow 的 `iflow.js` 所在目录
2. 将 `.json` 配置文件复制到 `~/.iflow/` 目录
3. 在 `iflow.js` 中找到 `},A2=new Dqe});`，插入对应的 require 语句
4. 重启 iFlow

### mod.json includeMap

```json
{
  "loader.cjs": "core",      // 加载器 → iflow.js 所在目录
  "config.json": "~/.iflow"  // 配置 → 用户 home .iflow 目录
}
```

## 开发约定

- **源码改动极小**：patch 类型 MOD 仅修改 1 行，不改变原有闭包结构
- **加载器模块**：使用 CommonJS（`.cjs`），导出 `{ load }` 函数
- **配置文件**：JSON 格式，放置在 `~/.iflow/`，加载失败时静默回退到默认规则
- **变量命名**：源码中使用混淆名（`_4`, `A2`, `Dqe`），加载器中使用语义名（`MultimodalHelperClass`, `adapter`）
- **错误处理**：配置文件不存在/语法错误 → 静默忽略；正则非法 → console.warn + 跳过
- **日志**：使用 `[ThinkingModel]` / `[MultimodalModel]` 前缀的 console.log/warn

## 环境信息

- **平台**：Windows (win32 10.0.26200)
- **iFlow 版本**：0.5.19
- **Node.js**：iFlow 内置运行时
- **Git**：2.49.0
- **curl**：8.19.0
- **注意**：rg (ripgrep) 未安装，搜索请使用 search_file_content 工具