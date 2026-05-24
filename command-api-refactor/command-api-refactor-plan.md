# 命令注册 API 方案

## 一、背景与目标

### 1.1 项目背景

iFlow CLI 使用混淆后的 JavaScript 代码，目前不支持动态注册命令。现有命令（如 `/model`, `/online` 等）都是硬编码在源码中的。

当前的 api-command-refactor MOD 需要使用 `type: "replace"` 模式进行整体替换，这种方式的缺点是：
- 每次 iFlow 升级都需要重新替换整个代码段
- 与其他 MOD 难以共存

### 1.2 目标

实现一个 patch 类型的 MOD，给 iflow.js 添加命令注册 API（`registerCommand`），使得其他 MOD 可以通过调用 API 来注册新命令，而无需修改源码。

---

## 二、技术方案

### 2.1 核心思路

通过 patch 方式在 iflow.js 的某个关键位置注入命令注册 API，类似于 `thinking-mode-refactor` 使用的方式。

关键点：
1. 找到一个合适的注入点（在 yargs 命令定义之前）
2. 创建一个全局命令注册表对象
3. 暴露 `registerCommand` API
4. 修改 yargs 命令注册逻辑，支持注册表中的命令

### 2.2 注入点选择

参考 `thinking-mode-refactor` 的插入点模式 `},A2=new Dqe});`，在 iflow.js 中找到精确位置：

**精确注入点**: L950 行
```javascript
},A2=new Dqe});
```

这是 Dqe（ModelCapabilities）类初始化后的位置，是所有 patch MOD 的统一注入点。

**源码上下文**:
```javascript
// L948-952
...modelCapabilities.set(n,r)},A2=new Dqe});function Pln(){
```

**注入后代码**:
```javascript
...modelCapabilities.set(n,r)},A2=new Dqe,require('./command-registry-loader.cjs').load(A2)});function Pln(){
```

这确保了命令注册 API 在任何其他命令被注册之前就已可用。

---

## 三、实现细节

### 3.1 命令注册 API 设计

**code.js 文件内容** (实际实现):

```javascript
// Command Registry API - 注入代码
// 在 A2=new Dqe}); 之后插入命令注册 API

// 注入的命令注册表代码
const __iflow_command_registry__ = {
  commands: new Map(),

  registerCommand: function(commandDef) {
    if (!commandDef || !commandDef.name) {
      console.warn('[CommandAPI] Invalid command definition: missing name');
      return false;
    }

    const name = commandDef.name;
    this.commands.set(name, {
      name: name,
      description: commandDef.description || '',
      builder: commandDef.builder,
      handler: commandDef.handler,
      aliases: commandDef.aliases || [],
      options: commandDef.options || {}
    });

    console.log(`[CommandAPI] Registered command: /${name}`);
    return true;
  },

  unregisterCommand: function(name) {
    if (this.commands.has(name)) {
      this.commands.delete(name);
      console.log(`[CommandAPI] Unregistered command: /${name}`);
      return true;
    }
    return false;
  },

  getCommands: function() {
    return Array.from(this.commands.values());
  },

  getCommand: function(name) {
    return this.commands.get(name);
  },

  hasCommand: function(name) {
    return this.commands.has(name);
  }
};

// 导出到全局对象
global.registerCommand = function(commandDef) {
  return __iflow_command_registry__.registerCommand(commandDef);
};

global.unregisterCommand = function(name) {
  return __iflow_command_registry__.unregisterCommand(name);
};

global.getRegisteredCommands = function() {
  return __iflow_command_registry__.getCommands();
};

global.getCommand = function(name) {
  return __iflow_command_registry__.getCommand(name);
};

console.log('[CommandAPI] Command registry initialized');
```

### 3.2 加载器模块

创建 `command-registry-loader.cjs`:

```javascript
// command-registry-loader.cjs
module.exports = {
  load: function(target) {
    // target 是 A2 (Dqe 实例)，这里可以忽略
    // 注册表已通过 patch 注入到 global 对象

    console.log('[CommandAPI] Loader loaded');

    // 可以在这里加载外部命令配置文件
    // 实际加载逻辑由 api-command-refactor MOD 完成

    return target;
  }
};
```

### 3.2 代码注入位置

在 yargs 命令定义之前注入注册表和 API：

```javascript
// 原始代码 (~L5305)
var HQi={};Wi(HQi,{agentCommand:()=>D6r});var D6r,I6r=j(()=>{"use strict"...});

// 注入后
var HQi={},__iflow_command_registry__={...};Wi(HQi,{agentCommand:()=>D6r});var D6r,I6r=j(()=>{"use strict"...
```

### 3.3 命令加载器模块

创建 `command-registry-loader.cjs` 文件，放置到 iFlow 的 `core/` 目录：

```javascript
// command-registry-loader.cjs
module.exports = {
  load: function(registry) {
    // 注册表已通过 patch 注入
    // 这里可以加载外部命令配置
    const path = require('path');
    const fs = require('fs');
    
    // 尝试加载用户自定义命令
    const customCommandsPath = path.join(process.env.HOME || process.env.USERPROFILE, '.iflow', 'commands.json');
    
    try {
      if (fs.existsSync(customCommandsPath)) {
        const commands = JSON.parse(fs.readFileSync(customCommandsPath, 'utf-8'));
        commands.forEach(cmd => {
          if (cmd.name && cmd.handler) {
            global.registerCommand(cmd);
          }
        });
        console.log(`[CommandAPI] Loaded ${commands.length} custom commands`);
      }
    } catch (e) {
      console.warn('[CommandAPI] Failed to load custom commands:', e.message);
    }
    
    return registry;
  }
};
```

---

## 四、配置文件格式

### 4.1 用户自定义命令配置

`~/.iflow/commands.json`:

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

> **注意**：出于安全考虑，用户配置文件只包含元数据，实际命令逻辑通过其他 MOD 注入。

---

## 五、其他 MOD 如何使用

其他 MOD 可以通过以下方式注册命令：

```javascript
// 在 MOD 的加载器模块中
if (typeof global.registerCommand === 'function') {
  global.registerCommand({
    name: 'api',
    description: '切换 API Profile',
    builder: (yargs) => yargs
      .option('profile', {
        alias: 'p',
        describe: 'API Profile 名称',
        type: 'string'
      }),
    handler: async (argv) => {
      // 命令逻辑
      console.log('Switching to profile:', argv.profile);
    }
  });
}
```

---

## 六、与 api-command-refactor 的关系

api-command-refactor MOD 将依赖此 MOD，通过 `registerCommand` API 注册 `/api` 命令，而不是使用 replace 模式整体替换代码。

依赖关系：
- **command-api-refactor**（基础）: 提供命令注册 API
- **api-command-refactor**（应用）: 使用 API 注册 /api 命令

---

## 七、实现步骤

1. **分析 iflow.js 源码**
   - 确认 yargs 命令注册位置
   - 找到最佳注入点

2. **创建 code.js**
   - 在注入点插入命令注册表代码
   - 确保不破坏现有功能

3. **创建加载器模块**
   - `command-registry-loader.cjs`
   - 处理自定义命令加载

4. **创建配置文件**
   - `~/.iflow/commands.json` 模板

5. **测试**
   - 验证 API 可用性
   - 验证命令注册功能

---

## 八、错误处理

| 场景 | 处理方式 |
|------|----------|
| 注入点不存在 | 报错并提示手动检查 |
| commands.json 格式错误 | 跳过并打印警告 |
| registerCommand 参数无效 | 返回 false 并打印警告 |

---

## 九、日志输出

使用 `[CommandAPI]` 前缀：

```javascript
console.log('[CommandAPI] Command registry initialized');
console.log('[CommandAPI] Registered command: /api');
console.log('[CommandAPI] Loaded 3 custom commands');
console.warn('[CommandAPI] Failed to load custom commands:', error.message);
```

---

## 十、兼容性

- **iFlow 版本**: 0.5.19
- **Node.js**: iFlow 内置运行时
- **与其他 MOD 共存**: 通过不同的注入点实现共存

---

## 十一、后续扩展

命令注册 API 可以扩展支持：
- 命令别名（alias）
- 命令分组（group）
- 命令权限（permissions）
- 命令参数验证（schema validation）