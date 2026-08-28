# Memory Optimizer Refactor

为长时间运行的 iFlow CLI 提供**内存看门狗 + 诊断层**，用于定位并缓解「用久了内存缓慢膨胀、几小时后卡顿」的问题。

## 问题根源

iFlow 长会话 RSS 会随时间缓慢上升，这是典型的「堆增长 + GC 延迟/碎片化」症状。排查 `iflow.js.original` 后确认：

- iFlow **没有内存看门狗**，也从不主动调用 `global.gc()`
- 没有 `v8.writeHeapSnapshot` 相关调用，用户无法导出堆快照做离线分析
- 会话历史保存在模块闭包内的 `k4e` 类（`this.history` 数组，`addHistory/setHistory`），仅由 L950 逗号表达式插入点**无法安全触达**，裁剪它需要 `replace` 类型 MOD

因此本 MOD 聚焦「可观测 + 缓解」：先给出实时内存数据与快照能力，让你用真实数据定位泄漏点，同时在临界阈值自动 GC / 转储。

## 功能

1. **周期采样**：定时 `process.memoryUsage()` 写入环形缓冲（默认 30s / 保留 120 条），记录 RSS 随时间的增长曲线
2. **分级阈值**：
   - `warnThresholdMB`（默认 1024）：超过时节流告警（`logWarnCooldownMs` 控制频率）
   - `criticalThresholdMB`（默认 1600）：超过时执行缓解动作
3. **临界缓解**：
   - `autoGc`：强制 `global.gc()`（需 `--expose-gc`，否则提示如何启用）
   - `heapSnapshotOnCritical`：写入 V8 堆快照（`snapshotCooldownMs` 冷却，默认 5 分钟一次）
4. **全局 API** `global.__iflowMemory`：`stats()` / `gc()` / `snapshot([dir])` / `getSamples()` / `start()` / `stop()`
5. **`/mem` 命令**（可选）：当检测到 `command-api-refactor` 框架（`global.registerSlashCommand`）时自动注册
   - `/mem` — 打印内存概览
   - `/mem gc` — 手动强制 GC
   - `/mem snapshot` — 立即导出堆快照

## 架构

```
load()
  ├─ loadConfig()            ← 读取 ~/.iflow/memory-optimizer.json（缺失/非法回退默认）
  ├─ installGlobalApi()      ← global.__iflowMemory = { stats, gc, snapshot, ... }
  ├─ registerSlashCommand()  ← 若存在 global.registerSlashCommand 则注册 /mem
  └─ startWatchdog()         ← setInterval(tick).unref()
       └─ tick()
            ├─ sample()                       ← 环形缓冲
            ├─ RSS ≥ critical → forceGc() / writeHeapSnapshot()
            └─ RSS ≥ warn     → 节流告警
```

**为什么 unref()**：采样定时器 `unref()` 后不会因为看门狗而阻止进程正常退出。

**global.gc 检测**：`global.gc` 仅在 `--expose-gc` 下存在。检测一次；不可用时 MOD 仍提供采样 + 快照 + 日志能力，并提示通过 `NODE_OPTIONS=--expose-gc` 启用。

## 文件说明

| 文件 | 说明 |
|------|------|
| `code.js` | 修改后的 iFlow 源码包。在 `A2=new Dqe` 后插入 `,require('./memory-optimizer-loader.cjs').load()`（原始文件已自带 ESM wrapper，无需额外添加）。 |
| `memory-optimizer-loader.cjs` | 看门狗 + 诊断加载器，导出 `{ load }`。 |
| `memory-optimizer.json` | 外部配置文件模板。 |
| `mod.json` | Mod 元数据。 |

## 安装

### 方式一：通过 iFlow Mod 管理器

1. 构建 Mod 包
2. 在 iFlow 的 Mod 管理器中导入安装
3. 重启 iFlow

### 方式二：手动安装

1. 将 `memory-optimizer-loader.cjs` 复制到 iFlow 的 `iflow.js` 所在目录
2. 将 `memory-optimizer.json` 复制到 `~/.iflow/` 目录
3. 在 `iflow.js` 中找到 `},A2=new Dqe});`，将其改为 `},A2=new Dqe,require('./memory-optimizer-loader.cjs').load()});`
4. （可选）启用自动 GC：设置环境变量 `NODE_OPTIONS=--expose-gc` 后再启动 iFlow
5. 重启 iFlow

## 配置说明

编辑 `~/.iflow/memory-optimizer.json`。

### 默认配置

```json
{
  "enabled": true,
  "sampleIntervalMs": 30000,
  "warnThresholdMB": 1024,
  "criticalThresholdMB": 1600,
  "autoGc": true,
  "heapSnapshotOnCritical": false,
  "snapshotDir": "",
  "snapshotCooldownMs": 300000,
  "maxSamples": 120,
  "logWarnCooldownMs": 60000
}
```

### 字段

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 关闭看门狗（仍暴露手动 API 与 /mem） |
| `sampleIntervalMs` | `30000` | 采样间隔（最小 1000） |
| `warnThresholdMB` | `1024` | 告警 RSS 阈值 |
| `criticalThresholdMB` | `1600` | 临界 RSS 阈值（触发 GC / 快照） |
| `autoGc` | `true` | 临界时强制 GC（需 `--expose-gc`） |
| `heapSnapshotOnCritical` | `false` | 临界时自动写堆快照 |
| `snapshotDir` | `""` | 快照目录，空 = `~/.iflow/heap-snapshots` |
| `snapshotCooldownMs` | `300000` | 自动快照最小间隔 |
| `maxSamples` | `120` | 环形缓冲长度 |
| `logWarnCooldownMs` | `60000` | 告警日志节流间隔 |

## 分析堆快照

导出的 `.heapsnapshot` 文件可在 Chrome DevTools 中分析：`chrome://inspect` → Memory → Load，或 DevTools 的 Memory 面板 → Load，对比两次快照的对象增量定位泄漏点。

## 运行时 API

```js
global.__iflowMemory.stats()      // { rssMB, heapUsedMB, growthMB, spanMin, gcAvailable, ... }
global.__iflowMemory.gc()         // { ok, freedMB } 或 { ok:false, reason }
global.__iflowMemory.snapshot()   // { ok, file } 或 { ok:false, reason }
global.__iflowMemory.getSamples() // 采样数组
global.__iflowMemory.stop()       // 停止看门狗
global.__iflowMemory.start()      // 重新启动看门狗
```

## 兼容性

- **iFlow 版本**: 0.5.19
- **类型**: `patch`（1 行插入）
- **加载目标**: 无（`load()` 不依赖 A2/_4，仅初始化自身）
- **`/mem` 命令**: 需前置 `command-api-refactor`（提供 `global.registerSlashCommand`）；未安装时命令跳过注册，其余功能不受影响
- **与其他 MOD 共存**: 与 thinking / streaming / multimodal / kimi / output-token 共用同一 L950 插入点，互不冲突

多 MOD 插入点示例：

```javascript
},A2=new Dqe,require('./thinking-model-loader.cjs').load(A2),require('./memory-optimizer-loader.cjs').load(),require('./multimodal-model-loader.cjs').load(_4)});
```

## 边界防护

| 异常场景 | 处理方式 |
|----------|----------|
| 配置文件不存在 / JSON 语法错误 | 使用内置默认配置 |
| 数值字段非法 | 回退该字段默认值 |
| `global.gc` 不可用 | 跳过 GC，提示启用 `--expose-gc` |
| `v8.writeHeapSnapshot` 不可用 | 返回 `{ ok:false, reason }`，不抛错 |
| 快照目录不可写 | 捕获异常，返回失败原因 |
| 采样异常 | 捕获并 console.warn，不中断定时器 |

## 局限

- **不裁剪会话历史**：历史数组在模块闭包类 `k4e` 内，本 `patch` 插入点无法安全访问。若需自动裁剪历史，应改为 `replace` 类型 MOD（后续可扩展）。
- **提高堆上限不在本 MOD**：如需 `--max-old-space-size`，通过 `NODE_OPTIONS` 环境变量设置，不需要改源码。

## License

MIT
