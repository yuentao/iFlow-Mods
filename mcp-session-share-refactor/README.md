# mcp-session-share-refactor

修复 `--experimental-acp` 模式下**每个 ACP 会话全量 spawn MCP stdio 进程链且永不回收**的缺陷——一个 VSCode 窗口能留下几十个 node.exe。

## 问题

CLI 0.5.19 bundle 实证（vendor 副本逐行核对）：

```
session/new | session/load → newSessionConfig() → Config.initialize()
   └─ createToolRegistry() → mcpClientManager.discoverAllMcpTools()
        └─ 对每个启用的 MCP 服务器 new McpClient → connect() + discover()
             └─ stdio transport: spawn(cmd → npx-cli → server → watchdog)   ← Windows 每服务器 ~3 个 node.exe
```

- 每个 ACP 会话（`session/new` 与 `session/load` 各一次）都构建全新 Config，各自 spawn **一整支** MCP 进程舰队。
- harness 的 restoreSession 先 probe `session/new` 再 `session/load` → 双倍舰队。
- ACP 方法表（bundle 内方法映射只有 authenticate/initialize/session_cancel/session_load/session_new）**没有 session/close**——被丢弃的 probe 会话舰队无人回收，常驻整个 CLI 进程生命周期。
- 实测 2026-10-05：单 VSCode 窗口、4 个 npx 型配置 → 58 个 node.exe。

## 修复

`discoverAllMcpTools` 方法体单点替换（锚点全文件唯一），原 spawn 逻辑逐字保留，外面包一层**进程级连接池**（`globalThis.__iflowMcpShare`，逻辑在 `mcp-session-share-loader.cjs`）：

```js
// 每个服务器先 await __mss.acquire(this, name, cfg)：
//   { client }   → 收养池里存活的客户端：重指向新会话的
//                  toolRegistry/promptRegistry/workspaceContext/config，
//                  仅 discover() 重放（两次 JSON-RPC 往返，零 spawn）
//   { spawn: true } → 跑原 spawn 路径，完成后 __mss.settle() 发布进池
```

首个会话认领 spawn 权并登记；后续会话收养。claim（pending）机制解决并发：mcp-background-loader 把 discovery 后台化后，probe `newSession` 与 `loadSession` 的 discovery **并发交叠**，无 claim 时两者都查空池都 spawn；有 claim 时第一个认领、第二个等待后收养。死亡/配置指纹变更 → 驱逐 → 回退原 spawn。loader 缺失/抛错 → 原逻辑执行（安全回退，与 mcp-background-loader、stream-toolcall-repair 同纪律）。

## 判定规则（mcp-session-share-loader.cjs）

`shouldShare()` 为 true 当且仅当：

1. `process.argv` 含 `--experimental-acp`（交互 TUI 与 `-p` 一次性运行永不携带，保持上游行为；该方法是 TUI `/mcp restart` 的公共路径，故用 argv 而非参数门控）
2. `IFLOW_MCP_SESSION_SHARE` 不为 `0|false`（显式禁用退回上游行为）

配置指纹用递归键排序 normalize（不同 Config 实例解析出的同值配置指纹一致），函数剔除，循环结构抛错视为不可共享。claim 超时 120s 可被接管，池自愈。

loader 不向 console 输出任何内容：ACP 模式 stdout 承载 NDJSON 协议流，杂散行会污染 wire。

## 退出安全

ACP 的 SIGINT/SIGTERM 路径调用每个会话 manager 的 `stop()`，逐个 `disconnect()` 其 clients 里的客户端——收养来的客户端同样登记在各 manager 的 map 里，disconnect 幂等，优雅退出时子进程链正常清理。

## 已知取舍

- 收养的客户端在两个会话间共享一条连接：一个会话 `stop()`（如 loadSession 顶替）会断开连接，另一会话下轮 discovery 检测到不健康后驱逐重建——多一次重连，不会用死连接。
- 配置指纹不同（如 `/mcp` 改了 env）→ 直接驱逐重建，不尝试热改。
- 池按服务器名 key：同名不同配置串行化（后到的驱逐先到的），与 CLI 上游「后写配置覆盖」语义一致。

## 文件

| 文件 | 说明 |
|------|------|
| `code.js` | 打补丁后的源码（original + 本 Mod 单点替换） |
| `mcp-session-share-loader.cjs` | 连接池决策层（acquire/settle/指纹/驱逐），装到 CLI bundle 同目录 |
| `mod.json` | Mod 元数据（type=patch，loader → core） |
