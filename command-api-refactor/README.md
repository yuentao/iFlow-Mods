# Command API Refactor

在 iFlow 中建立命令注册 API 框架，使外部 MOD 可以通过全局 API 动态注册 TUI slash 命令和 CLI 命令，而无需修改源码或用 `replace` 整体替换代码。

## 概述

iFlow CLI 的命令（如 `/model`、`/online` 等）硬编码在混淆源码中，外部 MOD 无法新增命令，只能通过 `type: "replace"` 整体替换源码，维护成本高且难以与其他 MOD 共存。

本 Mod 在 `A2 = new Dqe()` 之后插入一行加载代码，初始化命令注册表并暴露全局 API，为依赖框架的 MOD（如 api-command-refactor）提供统一的命令注册入口。

## 架构

```
command-registry-loader.cjs（加载器）
  ├─ 暴露全局 API（registerSlashCommand / registerCommand 等）
  ├─ loadCustomCommands()     → 加载 ~/.iflow/commands.json 自定义命令
  ├─ injectToYargs()          → 尝试注入已注册命令到 yargs
  ├─ loadDependentLoaders()   → 自动加载依赖本框架的 MOD loader（如 api-command-loader.cjs）
  ├─ setupYargsHook()         → Hook yargs.command，自动注入待处理命令
  └─ setupArgvMonitor()       → 定时监控 process.argv，补注入（兜底）
```

### 全局 API

| API | 说明 |
|-----|------|
| `registerSlashCommand(cmdDef)` | 注册 TUI slash 命令（`/xxx`），支持 `subCommands`、`altNames` |
| `unregisterSlashCommand(name)` | 取消注册 slash 命令 |
| `getSlashCommands()` | 获取已注册的 slash 命令列表 |
| `hasSlashCommands()` | 是否已有 slash 命令 |
| `registerCommand(cmdDef)` | 注册 CLI yargs 命令，支持 `builder`、`aliases`、`options` |
| `unregisterCommand(name)` | 取消注册 CLI 命令 |
| `getRegisteredCommands()` / `getCommand(name)` | 查询已注册的 CLI 命令 |

## 文件说明

| 文件 | 说明 |
|------|------|
| `code.js` | 修改后的 iFlow 源码包。在 `A2 = new Dqe()` 后插入 `,require('./command-registry-loader.cjs').load(A2)`。 |
| `command-registry-loader.cjs` | 命令注册 API 加载器模块。初始化注册表、暴露全局 API、注入 yargs、加载依赖 MOD loader。 |
| `code_backup.js` | 供参考的原始替换源码备份（无懒加载头）。 |
| `mod.json` | Mod 元数据，定义名称、版本、依赖、安装文件映射。 |

## 安装

### 方式一：通过 iFlow Mod 管理器

1. 构建 Mod 包
2. 在 iFlow 的 Mod 管理器中导入安装
3. 重启 iFlow

### 方式二：手动安装

1. 将 `command-registry-loader.cjs` 复制到 iFlow 的 `iflow.js` 所在目录
2. 在 `iflow.js` 中找到 `},A2=new Dqe});`，将其改为 `},A2=new Dqe,require('./command-registry-loader.cjs').load(A2)});`
3. 重启 iFlow

## 其他 MOD 如何使用

在依赖本框架的 MOD 加载器中，直接调用全局 API 注册命令：

```javascript
if (typeof global.registerCommand === 'function') {
  global.registerCommand({
    name: 'api',
    description: '切换 API Profile',
    builder: (yargs) => yargs.option('profile', { alias: 'p', describe: 'API Profile 名称', type: 'string' }),
    handler: async (argv) => {
      // 命令逻辑
    }
  });
}
```

## 用户自定义命令

本 Mod 会尝试从 `~/.iflow/commands.json` 加载用户自定义命令：

```json
{
  "commands": [
    {
      "name": "api",
      "description": "切换 API Profile",
      "builder": "(yargs) => yargs.option('profile', { type: 'string', describe: 'Profile name' })",
      "handler": "async (argv) => { /* ... */ }"
    }
  ]
}
```

> **安全提示**：出于安全考虑，用户配置文件只包含元数据，实际命令逻辑由其他 MOD 注入。

## 依赖 MOD 自动加载

`load()` 会尝试从多个路径自动加载 `api-command-loader.cjs` 等依赖此框架的 loader，实现"安装基础框架后，依赖 MOD 即自动生效"。

## 命令注入时序

yargs 可能尚未初始化完成，因此采用多级兜底策略：

```
1. load() 时立即注入已注册命令
2. yargs 未就绪 → 存入 global.__iflow_pending_commands__，等待
3. setupYargsHook() → Hook yargs.command，注入待处理命令
4. setupArgvMonitor() → 定时检查 process.argv，兜底补注入（30s 后停止）
```

## 边界防护

| 异常场景 | 处理方式 |
|----------|----------|
| registerCommand 参数缺少 name | console.warn + 返回 false |
| yargs 未安装 | 静默忽略，等待后续注入 |
| commands.json 不存在/格式错误 | console.warn + 静默跳过 |
| 依赖 MOD loader 加载失败 | 静默忽略，不影响主流程 |

## 与 api-command-refactor 的关系

- **command-api-refactor**（本 Mod，基础架构）：提供命令注册 API 框架
- **api-command-refactor**（应用）：依赖本框架，通过 `registerCommand` / `registerSlashCommand` 动态注册 `/api` 命令

两者配合后，不再需要 `replace` 模式整体替换源码。

## License

MIT