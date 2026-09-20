# stream-toolcall-repair-refactor

修复 iFlow CLI 流式（SSE）响应中 `tool_calls` 增量重组缺陷的 patch 型 MOD。根因分析见仓库根目录 `empty-command-error-analysis.md`。

## 问题背景

扩展（ACP headless 模式）强制 `--stream` 后，部分模型（如 sensenova）调用 `run_shell_command` 反复失败：`Internal Error: 命令不能为空`。同一模型在 TUI（非流式完整 JSON 路径）下完全正常。

`parseStreamResponse`（`iflow.js.original` L961-L962）的 SSE 重组器存在三个缺陷：

| # | 缺陷 | 后果 |
|---|------|------|
| ① | 重组只按 `id` 对齐（`y.id ?? this.currentToolCallId`），完全忽略 OpenAI 规范的 `index` 字段 | 端点不回传 `id`（首片之后只有 `index`+arguments）时，分片叠到错误调用上，拼出非法 JSON |
| ② | `JSON.parse` 失败的兜底是 `args:{}` 而非丢弃 | 空对象通过消费端 `typeof args !== "undefined"` 守卫进入工具调度 → `run_shell_command` 收到空 `command` → 报「命令不能为空」 |
| ③ | entry 创建后不再补全 `name`/`id`（`s.has(key)` 时跳过更新） | 首片不含 name 的调用在 finish 时被静默丢弃 |

## 修复方案

**插入机制（方法体委托，不经过 L950）**：在 `parseStreamResponse` 方法体开头插入一句委托调用。loader 存在且决定接管时 `yield*` 委托给修复版解析器；loader 缺失、被禁用或模型不匹配时静默回退原始实现（行为与原版完全一致）。

```
原始: async*parseStreamResponse(e){if(!e.body)throw new Error("Response body is null");...
修改: async*parseStreamResponse(e){try{let __rep=require('./stream-toolcall-repair-loader.cjs');if(__rep&&typeof __rep.parseStreamResponse==="function"){let __gen=__rep.parseStreamResponse.call(this,e);if(__gen)return yield*__gen}}catch(__re){}if(!e.body)throw new Error("Response body is null");...
```

`code.js` 第一行已自带 ESM wrapper（`createRequire`），无需额外添加。

**修复版解析器的三项修复**：

1. **index 对齐**：`byIndex` / `byId` 双映射指向同一 entry，兼容只回传 `index` 不回传 `id` 的端点（OpenAI 规范行为）；并行多调用按 index 正确分离。id/name 延迟到达时补全 entry，部分卡（`args:undefined`，TUI/ACP pending UI 用）每个调用只发一次。entry 无 id 时 finish 阶段生成 `call_<ts>_<rand>` 兜底 id。
2. **坏调用丢弃**：`JSON.parse` 失败默认 `drop`（跳过该 functionCall），可选 `empty` 恢复旧行为。arguments 从未到达（空串）属合法无参调用 → `{}`。
3. **本地截断修复**：可选 `repairTruncatedJson`——闭合未终止字符串、丢弃悬空键、缺失值补 `null`、补齐括号，仅在 `JSON.parse` 失败后尝试，不影响健康数据。

其余逻辑（reasoning_content / signature / content / usage / finishReason 映射）与原始实现逐行等价。

## 配置文件

`~/.iflow/stream-toolcall-repair.json`（热重载，5 秒 TTL，改后数秒生效）：

```json
{
  "version": "1.0.0",
  "enabled": true,
  "modelPatterns": [],
  "onParseError": "drop",
  "repairTruncatedJson": true,
  "dropEmptyArgs": false,
  "logDropped": true
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | `false` 时完全回退原始解析器 |
| `modelPatterns` | `[]` | 正则数组；空 = 所有模型，非空 = 仅匹配模型走修复路径 |
| `onParseError` | `"drop"` | `"drop"` 丢弃坏调用 / `"empty"` 旧行为兜底 `args:{}` |
| `repairTruncatedJson` | `true` | 解析失败时先尝试本地闭合修复 |
| `dropEmptyArgs` | `false` | `true` 时连无参调用（空 arguments）也丢弃 |
| `logDropped` | `true` | 丢弃/修复时输出 `console.warn` 日志 |

## 运行时 API（global 上）

- `getStreamToolCallRepairConfig()` — 当前生效配置
- `updateStreamToolCallRepairConfig(partial)` — 合并更新并写盘
- `reloadStreamToolCallRepairConfig()` — 强制重读配置文件
- `shouldRepairStreamModel(model)` — 查询某模型是否走修复路径

## 手动安装

1. 将 `stream-toolcall-repair-loader.cjs` 复制到 iFlow 的 `iflow.js` 所在目录
2. 将 `stream-toolcall-repair.json` 复制到 `~/.iflow/` 目录
3. 用 `code.js` 替换原 `iflow.js`（或手动在 `async*parseStreamResponse(e){` 后插入上方委托语句）
4. 重启 iFlow

## 验证

- 插入点全文唯一；code.js 往返替换后与 `iflow.js.original` 逐字节一致（除 209 字节插入片段）
- `node --check` 通过 loader（CJS）与 code.js（ESM，按 .mjs 校验）
- 29 项模拟 SSE 流单测全部通过，覆盖：规范分片、无 id 分片（sensenova 形态）、并行双调用交叉分片、坏 JSON 丢弃、截断修复、无参调用、文本/思考/usage 透传、模型过滤、修复器单元形态

## 兼容性

- **不经过 L950 插入点**，与 thinking / multimodal / streaming / kimi / output-token 等所有 A2 系 MOD 零冲突，可叠加共存
- loader 文件缺失时委托语句静默回退，code.js 单独使用也安全
- 日志前缀：`[StreamToolCallRepair]`

## 注意

- 本 MOD 修复的是 CLI 侧重组逻辑（报告修复方向 1/2/3）；报告方向 4（ACP 主循环对 `MALFORMED_FUNCTION_CALL` fail-fast）属 ACP 适配层，不在本 MOD 范围
- `onParseError:"drop"` 下被丢弃的调用不会进入调度，模型会在下一轮收到缺失 `functionResponse` 的上下文，有机会重新发起调用
