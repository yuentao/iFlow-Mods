# iFlowMods

iFlow CLI Mod 开发仓库 — 将硬编码逻辑解耦为用户可配置的外部规则。

## 是什么

iFlow CLI v0.5.19 的核心源码中存在大量硬编码的模型规则（思考模式、多模态识别、视觉模型路由、流式响应、token 上限等）。本仓库通过 **Mod（补丁/插件）** 机制，以极小的源码改动将这些规则外置到 JSON 配置文件，用户无需修改源码即可自定义模型行为。

## 设计原理

```
源码改动：1 行（逗号表达式插入）
加载器模块：.cjs 文件（require 加载，patch 类方法）
配置文件：JSON（用户按需编辑，~/.iflow/ 目录）
```

所有 `patch` 类型 MOD 在同一插入点（`code.js` L950: `},A2=new Dqe});`）通过逗号表达式共存，互不干扰。`replace` 类型 MOD 整体替换源码，可与之共存。

## 可用 Mod

| Mod | 类型 | 状态 | 说明 |
|-----|:----:|------|------|
| 🔧 **thinking-mode-refactor** | patch | ✅ 已完成 | 思考模式配置化 — 12 条硬编码规则 → 外部 JSON，支持 DSL 编译 |
| 🖼️ **multimodal-image-refactor** | patch | ✅ 已完成 | 多模态图片识别配置化 — 50+ 硬编码模型 → 外部 JSON，支持 descriptionModel |
| 📡 **streaming-mode-refactor** | patch | ✅ 已完成 | 流式响应配置化 — nonStreamModels 正则 + forceNonStream 开关 + Ctrl+S 切换 |
| 📏 **output-token-limit-refactor** | patch | ✅ 已完成 | 输出 token 上限配置化 — 自定义 max_tokens，支持 floor / override 模式 |
| 🧩 **kimi-request-override-refactor** | patch | ✅ 已完成 | Kimi 请求参数兼容层 — 按模型名覆盖/删除请求字段 |
| 📐 **context-window-refactor** | patch | ✅ 已完成 | 修复状态栏上下文剩余百分比显示，与压缩逻辑统一读取 tokensLimit |
| 🔌 **command-api-refactor** | replace | ✅ 已完成 | 命令注册 API 框架 — 暴露 registerSlashCommand / registerCommand 全局 API |
| 🔄 **api-command-refactor** | patch | ✅ 已完成 | /api 命令 — TUI 中切换 API Profile（依赖 command-api-refactor） |
| 🧩 **gpt54-stream-adapter** | replace | ✅ 已完成 | gpt-5.4 专用流式 SSE 解析兼容层 |
| 🔧 **model-command-refactor** | replace | ✅ 已完成 | /model 命令重构 — 支持从 API 获取模型列表 |

### thinking-mode-refactor

将模型思考能力规则解耦到 `~/.iflow/thinking-models.json`。

**解决的问题**：iFlow 硬编码了 12 条模型思考规则（o1、deepseek、glm、claude、kimi 等），新增模型需修改源码。

**使用示例**：在 `~/.iflow/thinking-models.json` 中添加规则：
```json
{
  "models": [
    {
      "pattern": "my-custom-model",
      "supportsThinking": true,
      "maxThinkingTokens": 32000,
      "thinkingRequest": { "set": { "reasoning": true } }
    }
  ]
}
```

**加载目标**：`A2`（Dqe 实例），通过 `adapter.registerModel(regex, capability)` 注入。

### multimodal-image-refactor

将多模态模型识别规则和视觉模型路由解耦到 `~/.iflow/multimodal-models.json`。

**解决的问题**：
1. `isMultimodalModel()` 硬编码 50+ 视觉模型名，新增模型需修改源码
2. 图片描述模型名硬编码，无法运行时配置

**核心功能**：当 `isMultimodalModel()` 返回 false 时，使用 `descriptionModel` 指定的视觉模型处理图片。

**使用示例**：在 `~/.iflow/multimodal-models.json` 中配置：
```json
{
  "descriptionModel": "qwen3-vl-plus",
  "multimodalModels": ["my-vision-model"],
  "directMultimodal": false
}
```

**加载目标**：`_4`（MultimodalHelper 类），通过静态方法覆盖 + 实例方法覆盖。

### streaming-mode-refactor

将流式响应的硬编码行为解耦到 `~/.iflow/streaming-models.json`。

**解决的问题**：iFlow 默认对所有模型使用流式响应，但部分推理模型（o1/o3/o4 系列）不支持流式输出，需关闭 `stream` 参数。

**功能特性**：
1. **nonStreamModels 配置化** — 正则模式匹配模型名，匹配的模型强制关闭流式
2. **forceNonStream 全局开关** — 设为 `true` 时所有模型强制非流式
3. **Ctrl+S 快捷键切换** — 运行时切换当前模型的流式/非流式模式（非持久化）
4. **TUI 状态栏指示器** — 显示 `streaming: on/off`，首次附带 `(Ctrl+S)` 提示

**使用示例**：在 `~/.iflow/streaming-models.json` 中配置：
```json
{
  "forceNonStream": false,
  "nonStreamModels": ["o1-preview", "o1-mini", "o1-.*", "o3-.*", "o4-mini"]
}
```

**加载目标**：`A2`（Dqe 实例），monkey-patch `configureThinkingRequest` / `configureNonThinkingRequest`。

### output-token-limit-refactor

将硬编码的输出 token 上限表（`MOt` 函数）解耦到 `~/.iflow/output-token-limits.json`。

**解决的问题**：iFlow 硬编码了输出 token 上限（未知模型默认 8000、qwen3 默认 8192 等），对话中可能因 token 限制而截断响应。

**功能特性**：
- **floor（只调高）** — 仅当配置值高于默认值时生效
- **override（强制覆盖）** — 始终使用配置值

**使用示例**：在 `~/.iflow/output-token-limits.json` 中配置：
```json
{
  "models": [
    { "pattern": "my-model", "maxOutputTokens": 16384, "mode": "override" }
  ]
}
```

### kimi-request-override-refactor

为 Kimi 模型提供请求参数兼容层，配置位于 `~/.iflow/kimi-request-overrides.json`。

**解决的问题**：Kimi 模型（如 kimi-k3）与 OpenAI Compatible API 存在参数差异，需固定采样参数、清理 thinking、设置 reasoning_effort 默认值。

**功能特性**：按模型名匹配规则，覆盖或删除请求字段。

### context-window-refactor

修复状态栏上下文剩余百分比显示 0% 或计算不准确的问题。

**解决的问题**：状态栏上下文剩余百分比与实际压缩逻辑读取的 `tokensLimit` 字段不一致。

**核心变更**：让状态栏显示与压缩逻辑一样读取 `settings.json` 中的 `tokensLimit` 字段，保持两者一致。

### command-api-refactor

创建命令注册 API 框架，使外部 MOD 可以通过全局 API 动态注册 TUI slash 命令和 CLI 命令。

**核心 API**（暴露在 global 上）：
- `registerSlashCommand({name, description, handler, subCommands, altNames})` — 注册 TUI slash 命令
- `unregisterSlashCommand(name)` — 取消注册
- `getSlashCommands()` — 获取已注册命令列表
- `registerCommand({name, description, builder, handler, aliases})` — 注册 CLI yargs 命令
- `unregisterCommand(name)` — 取消注册

**依赖关系**：无依赖，其他 MOD 可依赖此框架（如 api-command-refactor）。

### api-command-refactor

添加 `/api` 命令，支持在 TUI 中切换 API Profile。

**依赖**：`com.command-api-refactor.mod`（需要命令注册 API 框架）。

**功能**：
1. `/api --list` — 列出所有 API Profile
2. `/api <profile-name>` — 切换到指定 Profile
3. 从 `~/.iflow/settings.json` 读取 `apiProfiles` 对象
4. 切换时更新 `currentApiProfile`、`baseUrl`、`apiKey`、`modelName` 字段

**注意**：仅支持 Profile **选择**，Profile 管理由外部工具 iFlow-Settings-Editor-GUI 负责。

### gpt54-stream-adapter

为 `gpt-5.4` 模型（OpenAI Compatible API 模式）提供专用的流式响应（SSE）解析兼容层。

**解决的问题**：iFlow 默认的流式解析器 `parseStreamResponse` 无法完整处理 gpt-5.4 的 SSE 分块格式，尤其是 `delta.reasoning_content`、`delta.signature`、`delta.tool_calls`、`usage` 等字段。

**核心变更**：新增 `parseGpt54CompatibleStream` 专用解析器，通过 `isGpt54StreamModel()` 按模型名路由（匹配 `^gpt-5.4`）。

**说明**：`replace` 类型，无独立 loader 与配置文件，所有逻辑内嵌于 `code.js`。

### model-command-refactor

重构 `/model` 命令，支持从 OpenAI Compatible API 获取模型列表。

**解决的问题**：`/model` 命令仅支持 iFlow/Aone 认证获取模型，OpenAI Compatible API 模式下只能手动输入。

**核心变更**：在 `rYi` 组件的 useEffect 中新增 API 获取分支，优先从 `{baseUrl}/models` 获取模型列表，失败时回退到 `AJ()`/`rgt` 硬编码列表。

## 安装

### 方式一：iFlow Mod 管理器

1. 下载 `dist/` 目录中的 `.iflow-mod` 文件
2. 在 iFlow 的 Mod 管理器中导入安装
3. 重启 iFlow

### 方式二：手动安装

以 thinking-mode-refactor 为例：

1. 将 `thinking-model-loader.cjs` 复制到 iFlow 的 `iflow.js` 所在目录
2. 将 `thinking-models.json` 复制到 `~/.iflow/` 目录
3. 在 `iflow.js` 中找到 `},A2=new Dqe});`，改为：
   ```
   },A2=new Dqe,require('./thinking-model-loader.cjs').load(A2)});
   ```
4. 重启 iFlow

**同时安装多个 Mod**：
```
},A2=new Dqe,require('./thinking-model-loader.cjs').load(A2),require('./streaming-model-loader.cjs').load(A2),require('./multimodal-model-loader.cjs').load(_4)});
```

## 兼容性

所有 `patch` 类型 MOD 使用统一插入点 L950，通过逗号表达式共存：

| MOD | 加载目标 | 类型 | 可共存 |
|:---:|:--------:|:----:|:------:|
| thinking-mode-refactor | A2 | patch | 与 streaming ✓ 与 multimodal ✓ |
| streaming-mode-refactor | A2 (monkey-patch) | patch | 与 thinking ✓ 与 multimodal ✓ |
| multimodal-image-refactor | \_4 (class) | patch | 与 thinking ✓ 与 streaming ✓ |
| api-command-refactor | A2 + global API | patch | 需 command-api-refactor 前置 |
| command-api-refactor | (replace) | replace | 独立，可与其他 patch 共存 |
| model-command-refactor | (replace) | replace | 独立替换 |
| output-token-limit-refactor | MOt | patch | 独立，可与其他 patch 共存 |
| kimi-request-override-refactor | 请求层 | patch | 独立，可与其他 patch 共存 |
| context-window-refactor | 状态栏 | patch | 独立，可与其他 patch 共存 |
| gpt54-stream-adapter | (replace) | replace | 独立替换 |

## 项目结构

```
iFlowMods/
├── iflow.js.original              ← 原始源码（7723行）
├── thinking-mode-refactor/        ← 思考模式 Mod
├── multimodal-image-refactor/     ← 多模态图片 Mod
├── streaming-mode-refactor/       ← 流式响应 Mod
├── output-token-limit-refactor/   ← 输出 token 上限 Mod
├── kimi-request-override-refactor/← Kimi 请求兼容 Mod
├── context-window-refactor/       ← 上下文窗口显示修复 Mod
├── command-api-refactor/          ← 命令注册 API 框架
├── api-command-refactor/          ← /api 命令 Mod
├── gpt54-stream-adapter/          ← gpt-5.4 流式适配 Mod
└── model-command-refactor/        ← /model 命令 Mod
```

每个 MOD 目录通常包含：
- `code.js` — 修改后的源码（patch 类型插入 require，replace 类型整体替换）
- `mod.json` — MOD 元数据（type、includeMap、dependsOn）
- `*.cjs` — 加载器模块（如果有）
- `*.json` — 配置文件模板（如果有）
- `README.md` — 使用文档
- `dist/` — 构建产物（`.iflow-mod` 安装包）

## License

MIT