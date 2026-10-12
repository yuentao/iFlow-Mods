# acp-usage-report-refactor

为 `--experimental-acp` 的 `PromptResponse` 附带权威 token 占用（`usage.lastRequestInputTokens`），供 iflow-harness 面板的上下文占用条替换 transcript 估算值。

## 背景（bundle 实证，CLI 0.5.19 custom.8）

- CLI 生成器层**本就捕获**每次请求的 usage：OpenAI 兼容路径把 SSE 的 `usage` 字段转成 `usageMetadata`（`n.usageMetadata={promptTokenCount:e.usage?.prompt_tokens...}`），Gemini 原生路径直接带；请求也带了 `stream_options:{include_usage:true}`。
- 但 ACP 会话层 `AcpSession.prompt()` 的工具循环只从响应块取 `candidates`/`functionCalls`，末尾 `return{stopReason:this.mapFinishReasonToStopReason(h)}` 把 usage 丢弃。
- **动态实证两个关键事实**（临时 DBG 注入跑真机）：
  1. `usageMetadata` 只挂在流的**末块**上（实测 15 个块仅第 15 块携带 `{promptTokenCount,candidatesTokenCount,totalTokenCount}`）；
  2. ACP 会话读不到 generator 的 `lastUsageMetadata`（`getContentGenerator().lastUsageMetadata` 实测 undefined——每请求新建 generator 或字段未共享）。
  → **块级捕获是唯一可行路径**，不是读 generator 字段。
- dispatcher（`session_prompt` handler）只对**入参** zod parse，`o.prompt(c)` 返回值直接透传——返回值加字段**不需要**动 zod schema。

## 机制

三处纯内联 mini-inject（逻辑是单赋值，无 loader 文件；env 开关在循环初始化处读一次，热路径零开销）：

1. **init-var**：`m={role:"user",parts:u},d=0,f=0,p=3,h;` 后声明 `__iflowU`——`null`=被 env 禁用 / `0`=启用未捕获 / `>0`=末次请求输入。
2. **capture**：`for await(let v of E){...}` 体内 `if(__iflowU!==null&&v.usageMetadata&&v.usageMetadata.promptTokenCount)__iflowU=v.usageMetadata.promptTokenCount;`——非零覆盖，末块胜出。
3. **return**：`return{stopReason:...}` 改为附 `...(__iflowU?{usage:{lastRequestInputTokens:__iflowU}}:{})`——spread 在 0/null（禁用或网关未回报）时产出 `{}`，运行时 PromptResponse 与上游逐字节一致。

语义：`lastRequestInputTokens` = 末次请求的 `promptTokenCount` = 轮末模型实际携带的上下文（系统提示 + 工具 schema + 历史 + 本轮工具 I/O）。这正是面板占用条 `contextUsed` 的口径。input/output 拆分与跨轮累计属第二档（wire 不带，需逐请求数组）。

## 开关

- `IFLOW_USAGE_REPORT=0|false` 退回上游（`__iflowU` 恒 null，return 不附字段）。
- 网关不回报 usage 时（BYOK 代理吞 `include_usage`）`__iflowU` 保持 0，同样不附字段——面板估算器继续兜底。
- 仅 `--experimental-acp` 路径受影响（注入点在 ACP 会话类内）；TUI 与 `-p` 不经过该代码。

## apply-patch.mjs

```
node apply-patch.mjs --base <in.js> --out <out.js>
```

三锚点各唯一 1 处 + 注入唯一性 + round-trip（NEW→OLD 还原必须与 base 逐字节一致），任一锚点漂移即硬失败。**换 CLI bundle 版本后必须重新生成锚点。**

## 验证（2026-10-12，iflow-harness）

`node test/fixtures/probe-usage-report.mjs`（对打过补丁的 vendor bundle 跑真实 ACP 全流程）：

- 默认 env：`{"stopReason":"end_turn","usage":{"lastRequestInputTokens":37404}}` ✅
- `IFLOW_USAGE_REPORT=0`：`{"stopReason":"end_turn"}`（keys 仅 stopReason）✅

扩展侧接线（iflow-harness）：`PromptResponse.usage` → `store.promptCompleted(stopReason, usage)` → `completePrompt` 写 `state.usageReport`（锚 `atBlockCount`）→ `refreshSessionUsage` 覆盖层盖 `contextUsed` 并置 `usageAuthoritative`；块数一变（下一轮流式/压缩卡）自动过期退回估算；`deleteUserMessageById` 显式清（chatHistory 同步截断）。

## mod.json / 交付

loader 无（纯内联）；include 仅 README + apply-patch.mjs。注入已应用到 vendor bundle 与本地定制 fork bundle（`@yuentao/iflow-cli@0.5.19-custom.8`，尚未发布 npm）。