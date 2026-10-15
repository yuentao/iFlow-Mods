# acp-context-report-refactor

让 `--experimental-acp` 会话把**每次请求的完整自动注入内容**（系统提示词全文、层级记忆全文、上下文文件路径与全部内容）落盘给 iflow-harness 面板，实现「模型看到了什么」的完全透明。

## 问题（CLI 0.5.19 bundle 逐行实证）

`GeminiClient.startChat()` 在构造 chat 前组装最终 system instruction：

```js
let m=this.config.getUserMemory(),d;
this.systemPrompt?d=this.systemPrompt
  :this.currentChatApprovalMode===dn.PLAN?d=await _dr(this.config,m)
  :d=await P0e(this.config,m),
this.appendSystemPrompt&&(d=d+`\r\n`+this.appendSystemPrompt);
...
this.chat=new k4e(this.config,this.getContentGenerator(),{systemInstruction:d,...})
```

- `d` = 最终系统提示词全文（核心提示词 / system.md 覆写 / plan 包装 + appendSystemPrompt）
- `m` = `getUserMemory()`，层级记忆全文（AGENTS.md/IFLOW.md 等上下文文件拼接后）
- `config.getGeminiMdFilePaths()` = 参与拼接的上下文文件路径列表

这些内容只存在于 CLI 进程内存，**从不经过 ACP wire**（`session/new` 的 `_meta` 只有 modes/models/commands；`~/.iflow/acp/sessions/<id>.json` 也不含 systemInstruction）。编辑器面板因此无法告知用户首次请求自动注入了什么。

## 补丁

方法体单点注入（不经 L950）。锚点（minified，custom.8 fork bundle 唯一 1 处；模板串内是**真实 CR/LF 控制字符**）：

```
this.appendSystemPrompt&&(d=d+\r\n+this.appendSystemPrompt);
```

注入后：

```js
...this.appendSystemPrompt&&(d=d+`\r\n`+this.appendSystemPrompt);
try{require('./acp-context-report-loader.cjs').report(this.config,d,m)}catch{}
```

loader 把 `{version: 2, capturedAt, cwd, model, systemPrompt}` 原子写（temp+rename）到 `IFLOW_HARNESS_CONTEXT_FILE` 指定的路径，每次 startChat 覆写。startChat 在 session/new、session/load、审批模式切换时都会重组 systemInstruction——报告恒为**当前会话最新**的请求上下文；harness 在首次 prompt 发起瞬间即可读到。

## 生效范围与开关

- 仅 `--experimental-acp` 且 `IFLOW_HARNESS_CONTEXT_FILE` 已设置（harness 面板每窗口注入）时写盘；TUI 与 `-p` 一次性运行零影响。
- `IFLOW_ACP_CONTEXT_REPORT=0|false` 显式退回上游。
- loader 缺失 / report 抛错 → 静默跳过，bundle 运行时行为与上游逐字节一致。

## 构建

```bash
node apply-patch.mjs --base <fork>/bundle/iflow.js --out <fork>/bundle/iflow.js
# 并把 acp-context-report-loader.cjs 复制到 bundle/ 目录
```

锚点不唯一或 round-trip 校验失败即硬退出——**改 CLI bundle 版本后必须重新生成锚点**。

## 验证（harness 侧）

`iflow-harness` 的 `test/fixtures/probe-context-report.mjs`：spawn 补丁后 CLI（带 `--experimental-acp` + `IFLOW_HARNESS_CONTEXT_FILE`），session/new 后断言报告文件出现且 systemPrompt 完整并内嵌层级记忆正文（AGENTS.md）。
