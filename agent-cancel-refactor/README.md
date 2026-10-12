# agent-cancel-refactor

为 `--experimental-acp` 增加**按 agentId 单独停止子代理**的协议通道 `_iflow/agent/cancel`。

## 背景（CLI 0.5.19 bundle 逐行实证）

每个 SubAgent 在 `createAndExecuteAgent()` 里本就有独立 AbortController：
`h=new sut(p.id,3e5,new AbortController,R=>{...ABORTED})`。但：

1. 父信号只单向传播（`o.addEventListener("abort",()=>h.abort("parent_aborted"))`），外部没有任何通道能触达 `h`；
2. ACP 方法表没有按代理取消（`session/cancel` 只 abort 整轮 `pendingPrompt`）；
3. 执行循环 `executeAgentWithSession` 把**父信号 `o`** 喂给 `sendMessageStream` 与 `executeToolCallsWithSession`——只 abort `h` 打不断在途 LLM 请求与 shell 工具。

CLI 其实已备好 90% 的中止语义：代理的 catch 判定 `o.aborted||h.getSignal().aborted` 后不重抛，返回 `{wasInterrupted:true}` 优雅结果，finally 清理齐全。缺的只是「外部触达 + 信号接线」。

## 机制（五处小注入，均不经过 L950）

| # | 锚点（0.5.19-custom.6/7 各唯一 1 处） | 注入 |
|---|---|---|
| 1 | `o.addEventListener("abort",()=>h.abort("parent_aborted"));` 后 | `require` loader 挂 `globalThis.__iflowAgentCancel` 并 `register(d,p.id,h)`（wire agentId + instanceId 双键） |
| 2 | `async executeAgentWithSession(e,r,n,o,s,a){` 体首 | `o=globalThis.__iflowAgentCancel?.mergedSignal?.(e.agentId,o)||o`（AbortSignal.any([父,子])，Node<20.3 有手动合成回退） |
| 3 | `default:throw El.methodNotFound(a)` 前 | `case"_iflow/agent/cancel"`：lazy require loader，`cancelAgent(u)`，缺失回退 `{stopped:false,reason:"no_loader"}` |
| 4 | `executeWithRetry` catch 开头 | `if(globalThis.__iflowAgentCancel?.isAborted?.(e))throw o;`（abort 不被当瞬态失败重试 3 轮） |
| 5 | finally `this.recursionGuard.exitCall(p.id),h.cleanup()` | 中间插 `unregister(d,p.id)` |

除 #1 外其余四处都走 `globalThis.__iflowAgentCancel?.…?.()` 可选链，loader 文件缺失时整条表达式短路为 undefined——静默回退上游行为，无需 try/catch。#3 自带 lazy require（首个 cancel 可能早于任何子代理创建，此时 register 注入点尚未执行）。

## 语义

- `cancelAgent({sessionId, agentId})` → `{stopped:true}` / `{stopped:false,reason:"not_found"|"disabled"|"abort_failed"}`。wire agentId（`subagent-<instanceId>-<r>-<ts>`）全局唯一，无需会话作用域；sessionId 仅为协议对称保留。
- 被停代理：在途 fetch/shell 收到 abort → 代理 catch 优雅分支 → task 结果为「执行被中断」。**父代理继续跑**，兄弟代理不受影响。
- 面板卡片注意：适配器仍推 `AGENT_FAILED`（CLI 在 abort 判定前无条件发出），客户端按「自己发起过 stop 的 agentId」映射显示为「已停止」（iFlow-harness 扩展侧以 `SubAgentBlock.stopped` 实现）。

## 开关与回退

- 仅 `--experimental-acp` 生效（TUI 子代理与 `-p` 一次性不受影响）。
- `IFLOW_AGENT_CANCEL=0|false` 退回上游行为。
- loader 缺失/任何注入点抛错 → 原行为（与 mcp-session-share 同纪律）。
- loader 绝不写 console（ACP stdout 承载 NDJSON wire）。

## 构建

```
node apply-patch.mjs --base <bundle/iflow.js> --out <out.js>
```

锚点不唯一即硬失败；round-trip 校验（逐一反向替换必须逐字节还原 base）。**换 CLI bundle 版本后必须重新生成锚点**。

## 验证

- CLI 协议层（`test/fixtures/probe-agent-cancel.mjs`，直连 vendored CLI）：未知 agentId → `{stopped:false,reason:"not_found"}`；真实 task 子代理 → `{stopped:true}`、整轮 `stopReason=end_turn` 正常 settle、task 卡无 failed 更新。
- `npm run harness` 全流程通过（vendored custom.7）。
- 扩展面板按钮的端到端点击**尚未实测**（扩展侧已接线：`stopSubagent` → `client.cancelAgent` → `markSubAgentStopped` 乐观标「已停止」）。

## 交付状态

注入已应用到本地定制 fork bundle（`@yuentao/iflow-cli@0.5.19-custom.7`）；**custom.7 尚未发布到 npm**，当前 iFlow-harness 的 `vendor/iflow-cli` 经 `--from-dir` 装载本地产物。发布 npm 后 `npm run vendor:cli` 才能默认拉到带此 Mod 的 bundle。
