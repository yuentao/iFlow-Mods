# mcp-background-discovery-refactor

修复 `--experimental-acp` 模式下 MCP 服务器**同步**启动阻塞 ACP `initialize` 握手的缺陷。

## 问题

CLI 0.5.19 bundle 实证（vendor 副本逐行核对）：

```
ACP 启动 → await Config.initialize() → //ready → 才开始处理 JSON-RPC
   └─ this.toolRegistry = await this.createToolRegistry()
        └─ await e.discoverAllTools(this.isNonInteractive)
             └─ e ? await this.mcpClientManager.discoverAllMcpTools()   ← ACP 走这条
                            : this.startMcpDiscoveryInBackground()
```

- `isNonInteractive` 的构造值是 `... || argv.experimentalAcp`——**ACP 模式下为 true**，于是走同步 `await` 分支；交互 TUI（false）反而走后台分支。
- `discoverAllMcpTools()` 对全部服务器 `Promise.all(connect()+discover())`，`connect()` **没有任何超时**。
- npx 型 MCP 服务器在 npm registry 不可达时 `npx` 无限挂起 → `Promise.all` 永不落定 → `initialize()` 不返回 → ACP 握手永久卡死（实测 6+ 配置时 80s+ 无响应）。

## 修复

`discoverAllTools` 方法体单点替换（锚点全文件唯一）：

```js
// 原: e?await this.mcpClientManager.discoverAllMcpTools():this.startMcpDiscoveryInBackground()
// 改: await(async()=>{let __mb=!1;try{__mb=require('./mcp-background-loader.cjs').shouldBackground(e)}catch(__me){}
//     if(__mb)this.startMcpDiscoveryInBackground();else await this.mcpClientManager.discoverAllMcpTools()})()
```

ACP 场景改走 CLI 自带的 `startMcpDiscoveryInBackground()`（fire-and-forget，与 TUI 行为一致）：`initialize` 立即完成，MCP 工具在各自连接完成后陆续注册。loader 缺失/抛错 → `shouldBackground` 不被调用或返回假值 → 原逻辑执行（安全回退，与 stream-toolcall-repair 同纪律）。

## 判定规则（mcp-background-loader.cjs）

`shouldBackground(isNonInteractive)` 为 true 当且仅当：

1. `isNonInteractive === true`（非交互模式）
2. `process.argv` 含 `--experimental-acp`

`-p/--prompt` 一次性运行**保持原同步行为**——否则进程会在 MCP 工具注册前退出。`IFLOW_MCP_BACKGROUND=0|false` 显式禁用本 Mod（退回上游行为）。

loader 不向 console 输出任何内容：ACP 模式 stdout 承载 NDJSON 协议流，杂散行会污染 wire。

## 已知取舍

- 后台发现期间发起的首轮对话可能看不到慢服务器的工具，后续轮次出现（与 TUI 行为一致）。
- `discoveryState` 在 ACP 路径无消费者（bundle 实证），后台化不影响任何状态机。
- per-server 连接错误已在 `discoverAllMcpTools` 内部 catch，无 unhandled rejection。

## 文件

| 文件 | 说明 |
|------|------|
| `code.js` | 打补丁后的源码（original + 本 Mod 单点替换） |
| `mcp-background-loader.cjs` | 判定层（安装到 CLI `core/`，即 bundle 同目录） |
| `mod.json` | MOD 元数据 |
