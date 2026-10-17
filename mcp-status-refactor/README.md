# mcp-status-refactor

把 CLI 内部 `/mcp list` 的 MCP 连接状态、工具/提示声明与连接错误通过 ACP 方法
`_iflow/mcp/status` 上报给外部 client（iFlow-Harness 设置页状态灯 + 详情视图 +
上下文长度估算）。

## 背景（CLI 0.5.19 bundle 实证）

- `/mcp list` 状态源：`Djt`（name→status Map，`vk(name,status)` 写入，`Ese(name)`
  读，默认 DISCONNECTED）；discovery 状态 `Rjt()`（bE：not_started/in_progress/
  completed）。
- 工具数：`registry.getAllTools().filter(t => t.serverName === name)`；提示数：
  `promptRegistry.getPromptsByServer(name)`。MCP 工具实例（`bg`）带
  `name/description/schema`（`/mcp list schema` 打印 `parametersJsonSchema ?? parameters`）。
- 连接失败路径（`k2n` catch）只 `console.error` 错误文本并 `vk(…,DISCONNECTED)`，
  错误原因被丢弃——catch 点 capture 是唯一可行路径。
- ACP 方法表无状态查询；`AcpSession`（agent 类）构造器 `this.config` 存在，
  会话经 `sessions.get(sid).getConfig()`。

## 注入（四处，锚点各唯一 1 处，apply-patch 硬失败 + round-trip）

| # | 锚点 | 注入 |
|---|---|---|
| 1 | `Djt=new Map,Tjt=bE.NOT_STARTED,_se=new Map,Ijt=new Set` | require loader + `attach(Ese,Rjt)`（live readers） |
| 2 | `function vk(t,e){Djt.set(t,e);…}` 体内 | `record(t,e)` 状态镜像（attach 未跑时的回读） |
| 3 | k2n catch `…vk(t,Ss.DISCONNECTED)` | `recordError(t,u)` 连接错误 capture |
| 4 | 方法表 `default:throw El.methodNotFound(a)` | `case"_iflow/mcp/status"`：`status(o,u)`（lazy require，loader 缺失 → `{available:false,reason:"no_loader"}`） |

## 返回契约

```jsonc
{ "available": true, "discoveryState": "completed",
  "servers": { "<name>": {
    "status": "connected" | "connecting" | "disconnected",
    "toolCount": 3, "promptCount": 1,
    "tools":   [{ "name": "…", "description": "…", "schema": {…}, "schemaOmitted"?: true }],
    "prompts": [{ "name": "…", "description": "…" }],
    "disabled"?: true, "blocked"?: true,
    "error"?: "…", "errorKind"?: "spawn_failed"|"timeout"|"protocol_error"|"network_error"|"unknown"
  } } }
```

单 server tools JSON 4MB 预算（超限 drop schema + `schemaOmitted`，防 ACP 8MB
NDJSON frame 上限）；description 2000 字符、error 500 字符截。

## 开关与回退

- 仅 `--experimental-acp` 生效（TUI 不受影响，方法表 case 只在 ACP 路径）。
- `IFLOW_MCP_STATUS=0|false` → `{available:false,reason:"disabled"}`。
- loader 缺失/attach 失败 → 静回退（case 返回 no_loader；vk/error 无-op 可选链）。
- loader 永不 console（ACP stdout 是 NDJSON wire）。

## 验证（2026-10-16，iFlow-Harness `test/fixtures/probe-mcp-status.mjs`）

newSession → `_iflow/mcp/status` answers `{available:true, servers…}`；
`IFLOW_MCP_STATUS=0` 回 `{available:false,reason:"disabled"}`。
