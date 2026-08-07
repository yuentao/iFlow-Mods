# GPT-5.4 Stream Adapter

为 `gpt-5.4` 模型（OpenAI Compatible API 模式）提供专用的流式响应（SSE）解析兼容层，解决 gpt-5.4 在流式输出时推理内容、思考签名与工具调用等字段无法被 iFlow 正确识别的兼容问题。

## 概述

iFlow 默认的流式解析器 `parseStreamResponse` 无法完整处理 gpt-5.4 的 SSE 分块格式，尤其是：

- `delta.reasoning_content`（推理过程/思考内容）
- `delta.signature`（思考签名）
- `delta.tool_calls`（增量工具调用参数）
- `usage`（用量统计）

本 Mod 在 OpenAI Content Generator 中新增 `parseGpt54CompatibleStream` 专用解析器，并在 `generateContentStream` 中通过 `isGpt54StreamModel()` 按模型名路由：匹配 `gpt-5.4` 的模型走专用解析器，其余模型走原有 `parseStreamResponse`。

## 架构

```
generateContentStream()
  └─ isGpt54StreamModel(model)  → 正则匹配 /^gpt-5\.4(?:$|[-.:])/i
       ├─ true  → parseGpt54CompatibleStream(response)   ← 本 Mod 新增
       └─ false → parseStreamResponse(response)          ← 原有逻辑
```

### 专用解析器处理能力

| SSE 字段 | 处理方式 |
|----------|----------|
| `delta.reasoning_content` | 转换为 Gemini 思考块 `{thought: true, text}` |
| `delta.signature` | 作为思考签名 `thoughtSignature` 附加到思考块 |
| `delta.content` | 转换为普通文本块 `{text}` |
| `delta.tool_calls` | 增量拼接函数名与参数，结束时解析为 `functionCall` |
| `finish_reason` | 映射为 Gemini 的 `finishReason` |
| `usage` | 保存到 `saveUsageMetadata`，并生成 `usageMetadata` 回传 |
| `data: [DONE]` | 正常终止，跳过 |

## 文件说明

| 文件 | 说明 |
|------|------|
| `code.js` | 修改后的 iFlow 源码包（`type: "replace"`，整体替换）。新增 `parseGpt54CompatibleStream`、`isGpt54StreamModel` 及流式调试日志。 |
| `mod.json` | Mod 元数据，定义名称、版本、依赖、安装文件映射。 |

> 本 MOD 为 `replace` 类型，无独立 loader 与配置文件，所有逻辑内嵌于 `code.js`。

## 安装

### 方式一：通过 iFlow Mod 管理器

1. 构建 Mod 包
2. 在 iFlow 的 Mod 管理器中导入安装
3. 重启 iFlow

### 方式二：手动安装

1. 用 `code.js` 替换 iFlow 的 `iflow.js`
2. 重启 iFlow

## 使用说明

安装后无需额外配置。当当前模型名匹配 `^gpt-5.4`（如 `gpt-5.4`、`gpt-5.4-0807-global`）且走 OpenAI Compatible API 流式输出时，自动启用专用解析。

若模型匹配失败或解析异常，会输出 `[gpt54-stream-adapter]` 前缀的日志便于排查。

## 边界防护

| 异常场景 | 处理方式 |
|----------|----------|
| 非 gpt-5.4 模型 | 走原有 `parseStreamResponse`，不受影响 |
| 分块被 `\n\n` 截断 | 保留不完整块，累积到下一轮解析 |
| 非 `data:` 开头的流行 | console.warn + 跳过 |
| JSON 解析失败 | console.error + 跳过该块（debugMode 下打印完整 chunk） |
| 残留未消费缓冲 | 末尾统一兜底解析 |

## 兼容性

- **iFlow 版本**: 0.5.19
- **类型**: `replace`（整体替换源码）
- **适用模式**: OpenAI Compatible API 流式输出

## License

MIT
