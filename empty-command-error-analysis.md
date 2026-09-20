# 「Internal Error: 命令不能为空」根因分析

> 现象：扩展（ACP headless 模式）中部分模型（如截图中的 `sensenova-6.8-fas...`）调用 `run_shell_command` 时，工具卡反复失败并显示 `Internal Error: 命令不能为空`；**同一模型在 iFlow CLI 交互 TUI 中工具调用完全正常**（第二张截图证实：find / git status 等命令正常执行）。
> 分析方式：逐行检索 `vendor/iflow-cli/bundle/iflow.js`（CLI 0.5.19 定制 fork，14.2MB bundle）中的错误注入点、工具校验链路与 OpenAI 兼容响应转换链路，并对比 TUI 与 ACP 两条执行路径。以下所有代码片段均从 bundle 原文摘录（注明字节偏移）。

## TL;DR

**模型本身没问题（TUI 正常证实了这一点），分叉点是扩展强制 `--stream` 走的流式 SSE 解析路径。** TUI 与扩展共享同一个 CLI 进程、同一个 `OpenAIContentGenerator`、同一个 `run_shell_command` 工具，差异只有一处：**TUI 的 agent turn 循环（`Turn.run`）直接消费 ContentGenerator 的完整响应对象；ACP 的 agent turn 循环虽然也走同一 Turn，但其流式消费路径依赖 SSE 重组器，而扩展强制 `--stream` 使请求带 `stream:true`，响应按 SSE 增量分片返回。** 重组器（`parseStreamResponse`）对 tool_calls 的增量重组存在缺陷，导致部分模型（sensenova）的 arguments 碎片被拼坏或丢失，最终 `run_shell_command.execute()` 收到的 `args.command` 是**空串/undefined**，触发 `shellTool.errors.commandEmpty`（「命令不能为空」），再经 ACP 适配层 `TCr` 包装成 `Internal Error: 命令不能为空`。

「CLI 交互模式没问题」的完整解释见 §4——TUI 与 ACP 的 `Turn.run` 都会因 `config.stream` 走不同分支，**TUI 下该模型要么走了非流式路径（`sendMessageLatency`，完整 JSON 一次返回，`convertFromOpenAIResponse` 转换正常），要么其 SSE 分片恰好被 TUI 的聚合方式正确重组**；扩展强制 `--stream` 后，同一个模型的分片形态踩中重组器缺陷。

## 1. 错误文案的两层包装

### 1.1 文案本体：`shellTool.errors.commandEmpty`

`iflow.js` 中中文文案以 unicode 转义存储（偏移 ~1428795）：

```
shellTool:{errors:{commandEmpty:"\u547D\u4EE4\u4E0D\u80FD\u4E3A\u7A7A", ...
```

即 `命令不能为空`。

### 1.2 `Internal Error:` 前缀：ACP 层 `RequestError.internalError`

偏移 ~14126303：

```js
static internalError(r){return new t(-32603, r?`Internal Error: ${r}`:"Internal Error", r)}
```

### 1.3 注入点：`TCr` 只在 ACP 路径被调用

偏移 ~14142158：

```js
function TCr(t,e){
  if(t.error?.message) throw El.internalError(t.error.message);   // ← 拼出 "Internal Error: 命令不能为空"
  return t.returnDisplay ? ... : ...
}
```

`TCr` 的两个调用点都在 ACP 适配器（`runTool` ~14163729、@文件读取 ~14167746）；**TUI 的 ToolRegistry 调度层（`executeToolCall`，~10377370）不经过 `TCr`**，它把 `a.error.message` 放进 `setStatusInternal(n,"error",...)` 作为工具状态文本渲染，没有 `Internal Error:` 前缀——这是两端口径差异之一。

## 2. `run_shell_command` 的参数校验链（bundle 实证）

### 2.1 `execute()` 与 `validateToolParams()`（偏移 ~10076975）

```js
async execute(e,r,n,o){
  if(!e || !e.command){                       // ① undefined/null 挡住("" 也为 falsy,这里能挡)
    let O=I.t("shellTool.errors.commandEmpty");
    return{llmContent:O, returnDisplay:O, error:{message:O, type:Lr.INVALID_TOOL_PARAMS}}
  }
  let s=iat(e.command),                       // ② 剥壳:去掉 "powershell -Command" / "bash -c" 包裹层
  a=this.validateToolParams({...e, command:s});
  if(a) return{llmContent:a, returnDisplay:a, error:{message:a, type:Lr.INVALID_TOOL_PARAMS}};
  ...
}

validateToolParams(e){
  let r=R0r(e.command,this.config);           // 黑名单/白名单
  if(!r.allowed) return ...;
  let n=iu.validate(this.schema.parameters,e);
  if(n) return n;
  if(!e.command.trim()) return I.t("shellTool.errors.commandEmpty");   // ③ 纯空白串在这里被拦
  if(nat(e.command).length===0) return I.t("shellTool.errors.couldNotIdentifyCommand");
  ...
}
```

报「命令不能为空」说明到达 `execute` 的 `command` 是空串/纯空白，或 `iat()` 剥壳后为空（模型输出了只有包裹层的命令如 `"powershell -Command "`）。`{command: undefined}`（args 对象里缺 command 字段）同样命中 ①，文案相同。

### 2.2 `iat()` 剥壳函数（偏移 ~10060500）

```js
function iat(t){
  let e=/^\s*(?:(?:sh|bash|zsh)\s+-c|cmd\.exe\s+\/c|powershell(?:\.exe)?\s+(?:-NoProfile\s+)?-Command|pwsh(?:\.exe)?\s+(?:-NoProfile\s+)?-Command)\s+/i,
  r=t.match(e);
  if(r){
    let n=t.substring(r[0].length).trim();
    return(n.startsWith('"')&&n.endsWith('"')||...)&&(n=n.substring(1,n.length-1)),n
  }
  return t.trim()
}
```

## 3. 核心分叉：TUI 正常、扩展报错的原因

### 3.1 两条路径共享的部分

TUI 与 ACP 扩展使用**同一个 CLI 进程**的同一套组件：

- 同一个 `OpenAIContentGenerator`（`gH` 类，~3148400 区域）
- 同一个 `run_shell_command` 工具类（`Wu`）
- 同一个审批/调度核心

### 3.2 分叉点 1：`config.stream` 决定流式/非流式

扩展 `buildAcpCommand`（`src/acp/cli-locator.ts`）**强制带 `--stream`**：

```
// --stream (probed, CLI 0.5.19 bundle): without it `config.stream` is false
// and the ACP prompt handler awaits `sendMessageLatency` — the FULL model
// response arrives as one dump after each turn...
```

CLI 内部 `getStream()`（~10961130）返回该标志，控制两处分叉：

**分叉 A — agent turn 循环（ACP 主路径，~14156146）：**

```js
let E = this.config.getStream()
  ? await o.sendMessageStream(y,n)      // ← 扩展走这里(--stream 强制)
  : await o.sendMessageLatency(y,n);    // ← 非流式:完整 JSON 一次返回
```

**分叉 B — Chat 层（`sendMessageStream`，~10540460）：**

```js
let a = n
  ? await this.chat.sendMessageStream({...}, this.prompt_id)
  : await this.chat.sendMessageLatency({...}, this.prompt_id);
```

### 3.3 分叉点 2：非流式响应转换是完整的，流式 SSE 重组是有缺陷的

**非流式路径**（`generateContent` → `generateContentInternal(s=!1)` → `convertFromOpenAIResponse`，~3170812）：

- 完整 JSON 一次返回，`r.message.tool_calls` 是完整数组；
- `JSON.parse(a.function.arguments)` 失败时还有 `fixInvalidJsonWithQwen` 兜底（仅官方端点）；
- 转换出的 `functionCall` 参数完整 → 工具执行正常。**这就是 TUI 正常的原因**（TUI 的 `Turn.run` 默认非流式，见 §4）。

**流式路径**（`generateContentStream(s=!0)` → `parseStreamResponse`，~3177448）：请求体带 `p.stream=!0, stream_options={include_usage:!0}`，响应是 SSE 分片。重组器缺陷：

```js
if(A?.tool_calls) for(let y of A.tool_calls){
  if(this.currentToolCallId = y.id ?? this.currentToolCallId, !s.has(this.currentToolCallId)){
    let E={id:y.id||"", name:y.function?.name||"", args:""};
    if(s.set(this.currentToolCallId,E), E.id&&E.name){ /* yield 部分 functionCall(args:void 0) */ }
  }
  if(y.function?.arguments){
    let E=y.id ?? this.currentToolCallId, v=s.get(E);
    v && (v.args += y.function.arguments)     // ← 缺陷①:纯字符串拼接,忽略 OpenAI 规范的 index 字段
  }
}
...
if(b.finish_reason && (s.size>0||a)){
  ...
  for(let[,v] of s.entries()) if(v&&v.name)
    try{ let C=JSON.parse(v.args); E.content.parts.push({functionCall:{id:v.id,name:v.name,args:C}}) }
    catch{ E.content.parts.push({functionCall:{id:v.id,name:v.name,args:{}}}) }   // ← 缺陷②:兜底是空对象而非丢弃
}
```

| # | 缺陷 | 对 sensenova 的影响 |
|---|---|---|
| a | 重组只用 `id` 对齐，完全忽略 OpenAI 规范要求的 `index` 字段；`y.id ?? this.currentToolCallId` 在 id 缺失时沿用上一个 id | 若 sensenova 增量 chunk 不回传 `id`（首片带 id、后续只带 `index`+arguments，或根本不带 id），**一次返回多个 tool_call 或 id 交替缺失**时，arguments 片段叠到错误的调用上，拼出非法 JSON |
| b | `JSON.parse(拼接结果)` 失败的兜底是 `args:{}` 而不是丢弃该 functionCall | 空对象照样进入调度（`typeof C.args<"u"` 挡不住 `{}`），`runTool` 拿到 `s={}`，`s.command===undefined` → 报错 |
| c | `mapFinishReason` 把 `finish_reason:"tool_calls"` 映射为 `MALFORMED_FUNCTION_CALL`（~3179775），但 ACP 主循环对 `h=C.finishReason` 不特判 | 重组失败时循环仍继续执行 A 里已收集的（可能是坏的）functionCall，没有 fail-fast |

### 3.4 消费端守卫挡不住空对象

ACP 主循环（~14156476 / ~14156620）：

```js
// 中途 yield 的部分 functionCall(args:void 0)只推 pending 卡,不调度:
if(x.functionCall && !x.functionCall.args){ ...; continue }

// 只有 args !== undefined 才进入调度:
v.functionCalls?.forEach(C=>{ typeof C.args<"u" && A.push(C) })
```

`{}` !== `undefined` → 通过 → `runTool` → `run_shell_command.execute({callId,...{}})` → `!e.command` 命中 → 报「命令不能为空」。

## 4. 为什么 CLI 交互 TUI 没有这个问题

综合 bundle 证据，三个差异点（按重要性排序）：

1. **TUI 不带 `--stream`**：TUI 启动没有 `--experimental-acp --stream` 参数组合，`config.getStream()` 为 `false`，`Turn.run` 走 `sendMessageLatency` → `generateContentLatency`（~3151774，它内部就是调 `generateContent` 后包成单元素 async generator）→ **完整 JSON 一次返回** → `convertFromOpenAIResponse` 完整转换 tool_calls → 工具参数完整。扩展强制 `--stream` 后才走 SSE 重组器这条有缺陷的路径。
2. **错误呈现路径不同**：TUI 的 `executeToolCall` 把 `error.message` 作为工具状态文本渲染（无 `Internal Error:` 前缀）；ACP 的 `TCr` 把它包装成 JSON-RPC -32603 错误。
3. **TUI 有 next-speaker 检查与「Please continue」续跑**（~10541413），工具失败后模型有机会重新给出完整参数；ACP 循环的失败 `functionResponse` 虽然也会回传，但 sensenova 若每次流式重组都坏，重试也是坏的，表现为「一直出现」。

## 5. 证据链小结

```
扩展 spawn --experimental-acp --stream → config.stream=true
  → ACP turn 循环: sendMessageStream → SSE 分片响应
  → parseStreamResponse 重组 tool_calls:
      缺陷① 按 id 对齐忽略 index / id 缺失时叠到 currentToolCallId   [~3178967]
      缺陷② JSON.parse 失败兜底 args:{}                              [~3179385]
  → v.functionCalls: {} !== undefined → 进入 runTool                 [~14156620]
  → run_shell_command.execute: !e.command 命中                       [~10078020]
  → error.message = "命令不能为空"
  → TCr: throw El.internalError(...)                                 [~14142196]
  → RequestError(-32603, "Internal Error: 命令不能为空")             [~14126303]
  → 扩展收到 tool_call_update status:"failed" → 红色失败卡,反复出现
```

对照组（TUI，正常）：

```
TUI 启动无 --stream → config.stream=false
  → Turn.run: sendMessageLatency → generateContentLatency → generateContent
  → 完整 JSON → convertFromOpenAIResponse(完整 tool_calls 转换,坏 JSON 还有 Qwen 修复兜底)
  → 工具参数完整 → 执行正常
```

## 6. 可能的修复方向

CLI（vendor fork / iFlow-Mods patch 型 Mod）：

1. **SSE 重组器按 `index` 对齐**：`A.tool_calls` 循环改用 `y.index`（回退 `y.id ?? currentToolCallId`）作为 map key，兼容只回传 index 不回传 id 的端点（OpenAI 规范行为）。这是根因修复。
2. **`args:{}` 兜底改为跳过该 functionCall**（或标记 `MALFORMED_FUNCTION_CALL` 并中止本 turn），让消费端 `typeof C.args<"u"` 守卫能挡住，避免空参数进入工具调度。
3. **扩大 `fixInvalidJsonWithQwen` 适用面**：流式路径的重组失败也可配置化修复（当前硬编码只认官方两个端点，且只在非流式 `convertFromOpenAIResponse` 被调用）。
4. **ACP 主循环对 `MALFORMED_FUNCTION_CALL` fail-fast**：重组结果为空/坏时不执行已收集的坏 functionCall，直接以错误终止本 turn 并回传明确错误。

扩展侧（可做的缓解）：

- 失败卡对 `Internal Error:` 前缀做降噪展示（仅展示原始 message），改善可读性；但**根因在 CLI 的 SSE 重组器，扩展侧无法修复 args 本身**——错误发生在 CLI 进程内部，扩展只收到最终文案。

用户侧临时规避：

- 换用对 tool call 分片形态更规范的模型（glm/kimi/claude 系，其增量 chunk 通常带完整 `index`+`id`）；
- 若怀疑是特定端点的分片形态问题，用 `DEBUG=true` 抓 `prompt.txt` 核对该模型 `delta.tool_calls` 的实际字段（见 §7）。

## 7. 验证方法

```bash
# 复现:用 sensenova 模型在扩展里让它执行任意 shell 命令,观察失败卡
# 对照:同一模型在 TUI(终端直接跑 iflow)执行同样的 shell 命令,应正常

# 抓取真实请求体与响应:CLI DEBUG 模式把完整请求/响应落盘到 <cwd>/prompt.txt
#   gJ(): debugMode = argv.debug || env.DEBUG==="true"/"1" || env.DEBUG_MODE==="true"/"1"
#   非流式: logToPromptFile 写 "INPUT REQUEST"/"API RESPONSE"
$env:DEBUG="true"; npm run harness -- --prompt "运行 dir 命令"   # 配 IFLOW_CLI_ENTRY 指向 vendor 副本
```

在 `prompt.txt` 里核对响应 `delta.tool_calls` 的实际分片形态（是否带 `id`/`index`、arguments 是否多片拼接），即可实锤 §3.3 的哪个裂缝被触发。注意 DEBUG 模式的 `logToPromptFile` 主要记录非流式请求体；流式分片形态需在重组器处加临时日志（或用 iFlow-Mods patch 型 Mod 注入）确认。