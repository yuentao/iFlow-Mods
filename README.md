# iFlowMods

iFlow CLI Mod 开发仓库 — 将硬编码逻辑解耦为用户可配置的外部规则。

## 是什么

iFlow CLI v0.5.19 的核心源码中存在大量硬编码的模型规则（思考模式、多模态识别、视觉模型路由等）。本仓库通过 **Mod（补丁/插件）** 机制，以极小的源码改动将这些规则外置到 JSON 配置文件，用户无需修改源码即可自定义模型行为。

## 设计原理

```
源码改动：1 行（逗号表达式插入）
加载器模块：.cjs 文件（require 加载，patch 类方法）
配置文件：JSON（用户按需编辑，~/.iflow/ 目录）
```

所有 `patch` 类型 MOD 在同一插入点（`code.js` L950: `},A2=new Dqe});`）通过逗号表达式共存，互不干扰。

## 可用 Mod

| Mod | 状态 | 说明 |
|-----|------|------|
| 🔧 **thinking-mode-refactor** | ✅ 已完成 | 思考模式配置化 — 12 条硬编码规则 → 外部 JSON，支持 DSL 编译 |
| 🖼️ **multimodal-image-refactor** | ✅ 已完成 | 多模态图片识别配置化 — 50+ 硬编码模型 → 外部 JSON，支持 descriptionModel |
| 🔧 **model-command-refactor** | ✅ 已完成 | /model 命令重构 — 支持从 API 获取模型列表 |

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

### model-command-refactor

重构 `/model` 命令，支持从 OpenAI Compatible API 获取模型列表。

**解决的问题**：`/model` 命令仅支持 iFlow/Aone 认证获取模型，OpenAI Compatible API 模式下只能手动输入。

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
},A2=new Dqe,require('./thinking-model-loader.cjs').load(A2),require('./multimodal-model-loader.cjs').load(_4)});
```

## 兼容性

| thinking-mode-refactor | multimodal-image-refactor | 兼容 |
|:---:|:---:|:---:|
| ✅ | ✅ | ✅ 不同加载目标（A2 vs _4），同一插入点逗号表达式共存 |

## 项目结构

```
iFlowMods/
├── iflow.js.original              ← 原始源码（7723行）
├── thinking-mode-refactor/        ← 思考模式 Mod
│   ├── code.js                    ← 补丁源码
│   ├── thinking-model-loader.cjs  ← 加载器
│   ├── thinking-models.json       ← 配置模板
│   └── dist/                      ← 安装包
├── multimodal-image-refactor/     ← 多模态图片 Mod
│   ├── code.js
│   ├── multimodal-model-loader.cjs
│   ├── multimodal-models.json
│   └── multimodal-image-refactor-plan.md
└── model-command-refactor/        ← /model 命令 Mod
    ├── code.js
    └── dist/
```

## License

MIT
