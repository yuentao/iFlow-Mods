# acp-compress-persist-refactor

修复 `--experimental-acp` 下 **slash `/compress` 的压缩结果永不落盘**的缺陷。

## 问题（CLI 0.5.19 bundle 逐行实证）

`AcpSession.prompt()` 对 `/...` 提示走 `handleAcpSlashCommand()`，返回后**早返回**：

```js
if(y.handled){if(y.shouldEndTurn)return{stopReason:"end_turn"}; ...}
```

该早返回位于轮末 `finally { await this.saveSessionState() }` 之前——slash 命令处理完成后根本走不到落盘点。slash `/compress`（`compressCommand` action → `tryCompressChat(force)` → `updateClientAfterCompression` → `startChat(newHistory)`）只重写**内存** chat 历史，`~/.iflow/acp/sessions/<id>.json` 里仍是压缩前的全量历史。

下一次 `session/load`（iflow-harness 面板切 Profile 选「停留在当前会话」、重启恢复会话都走这条）`setHistory(全量历史)` 把未压缩历史整个灌回内存——模型上下文静默回涨到压缩前大小。面板 UI 显示「已压缩」（transcript 折叠估算），与 CLI 真实上下文脱节。

**实测证据**（iflow-harness，2026-10-08）：同一会话两次 `/compress` 的 `originalTokenCount` 均为 114057——第一次压缩已被中间的 keep-session 切换（session/load）静默还原；期间还伴随 HTTP 400（token 超限）与 HTTP 413（body 过大）。

## 补丁

方法体单点插入（不经 L950）。锚点（minified，original 与 vendor bundle 逐字节一致、各唯一 1 处）：

```
if(y.handled){if(y.shouldEndTurn)return{stopReason:"end_turn"};if(y.newPrompt)e.prompt=[{type:"text",text:y.newPrompt}];else return{stopReason:"end_turn"}}
```

注入后：

```js
if(y.handled){if(y.shouldEndTurn){try{let __cp=require('./acp-compress-persist-loader.cjs');__cp&&__cp.shouldPersist(b)&&await this.saveSessionState()}catch(__ce){}return{stopReason:"end_turn"}};...}
```

- `b` = 该 slash 命令的原始文本（`e.prompt[0].text.trim()`）
- `this.saveSessionState()` = CLI 自带落盘路径（幂等，序列化当前 chat——压缩成功后即压缩后历史）
- loader 缺失/抛错 → 原行为（安全回退，同 mcp-background-loader 纪律）
- loader 不写 console（ACP stdout 承载 NDJSON wire）

## loader 判定

`shouldPersist(cmdText)` 为 true 当且仅当命令名（首个分隔符前、首个空白 token、大小写不敏感）∈ `{compress, summarize, compact}`（内置压缩命令及其 altNames）。其余 slash 命令不改 chatHistory，不触发落盘。

`IFLOW_SLASH_PERSIST=0|false` 退回上游行为。

## 影响面

- 仅 ACP prompt 路径（该调用点只存在于 AcpSession.prompt）；TUI 与 `-p` 一次性压缩各有自己的持久化路径，不受影响
- 压缩**失败**时落盘只是重写未变化的历史——无害，且刷新 lastActivity
- 轮内自动压缩（tryCompressChat in prompt loop）本就在 finally 落盘范围内，与此补丁正交

## 重新生成

```
node apply-patch.mjs --base <bundle.js> --out <out.js>
```

锚点不唯一即硬失败——换 CLI 版本后按新 bundle 重新推导锚点（同其他 refactor Mod 纪律）。

## 验证（2026-10-08，iflow-harness）

- 锚点唯一性：original / fork bundle / vendor bundle 各 1 处；往返替换逐字节还原
- harness 实测：newSession → 多轮 prompt → `/compress` 后立即读 `~/.iflow/acp/sessions/<id>.json`，chatHistory 首条为压缩 summary turn（`This session is being continued...`）、条目数骤降；`session/load` 重放后不再回涨
