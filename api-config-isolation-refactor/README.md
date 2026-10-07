# api-config-isolation-refactor

隔离 iFlow-harness（VSCode 扩展）面板的 API 配置，防止泄漏到共享 `~/.iflow/settings.json` 影响终端 CLI 等其他进程。

## 根因（CLI 0.5.19 bundle 逐行实证）

- 核心 settings 模块的用户文件路径 `eJ = join(homedir(), ".iflow", "settings.json")` **硬编码 homedir，不认 IFLOW_HOME**。
- `saveSettings`（混淆名 `BMi`）是 `settings.setValue("User", ...)` 的**唯一咽喉点**，把内存里整份 User settings 序列化回写该文件。
- 面板经 ACP `authenticate` 推送 openai-compatible 凭据后，CLI 把 `apiKey`/`baseUrl`/`modelName`/`selectedAuthType` 等写进共享 settings.json —— 泄漏给所有读 `~/.iflow` 的进程。

## 机制

方法体接管（不经 L950）。单点替换 `saveSettings` 函数体开头，插入对 loader 的委托：

```javascript
function BMi(t){try{try{let __ai=require('./api-config-isolation-loader.cjs');if(__ai&&typeof __ai.intercept==="function"){let __r=__ai.intercept(t);if(__r===null)return;if(__r)t=__r}}catch(__ae){}let e=y5.dirname(t.path);…原逻辑…}catch(e){…}}
```

loader `intercept(t)` 返回值语义：`undefined` 放过、对象改写、`null` 跳过写入。loader 缺失/抛错 → 原行为（安全回退）。

## 隔离语义

仅当 `IFLOW_HARNESS` 为真 **且** 写入目标恰为用户级 `~/.iflow/settings.json` 时生效：

- 面板持有字段（`selectedAuthType`、`apiKey`、`baseUrl`、`searchApiKey`、`modelName`、`currentApiProfile`）：**从不**由子进程内存落盘，改为保留磁盘已有值原样写回 —— 终端用户的凭据不被抹除，面板凭据永不泄漏。
- 其余字段（`apiProfiles` 目录、语言、审批模式、`mcpServers`、`tokensLimit`…）照常持久化。

## 开关

- `IFLOW_HARNESS` 由 harness 扩展 spawn 时注入（非 harness 进程、TUI、`-p` 一次性完全不受影响）。
- `IFLOW_API_ISOLATION=0|false` 显式退回上游行为。

## 锚点

`Error saving user settings file`（saveSettings catch 块字符串常量）在 original 与 vendor bundle 中各唯一 1 处。换 CLI 版本后需按此字符串重新生成 code.js。
