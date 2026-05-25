// command-registry-loader.cjs
// 命令注册 API 加载器模块
// 负责初始化命令注册表并暴露全局 API

const path = require('path');
const fs = require('fs');

// ===== TUI Slash 命令注册表 =====
const __iflow_slash_commands__ = [];

/**
 * 注册 TUI slash 命令
 * @param {Object} commandDef - 命令定义
 * @param {string} commandDef.name - 命令名称（如 'api' 表示 /api）
 * @param {string} commandDef.description - 命令描述
 * @param {Function} [commandDef.handler] - 命令处理函数
 * @param {Array} [commandDef.subCommands] - 子命令列表
 * @param {Array} [commandDef.altNames] - 别名列表
 * @returns {boolean} 是否注册成功
 */
global.registerSlashCommand = function(commandDef) {
  if (!commandDef || !commandDef.name) {
    console.warn('[CommandAPI] Invalid slash command definition: missing name');
    return false;
  }

  const cmd = {
    name: commandDef.name,
    description: commandDef.description || '',
    handler: commandDef.handler || null,
    subCommands: commandDef.subCommands || [],
    altNames: commandDef.altNames || []
  };

  // 检查是否已存在
  const existingIndex = __iflow_slash_commands__.findIndex(c => c.name === cmd.name);
  if (existingIndex >= 0) {
    __iflow_slash_commands__[existingIndex] = cmd;
    console.log(`[CommandAPI] Updated slash command: /${cmd.name}`);
  } else {
    __iflow_slash_commands__.push(cmd);
    console.log(`[CommandAPI] Registered slash command: /${cmd.name}`);
  }

  return true;
};

/**
 * 取消注册 TUI slash 命令
 * @param {string} name - 命令名称
 * @returns {boolean} 是否取消成功
 */
global.unregisterSlashCommand = function(name) {
  const index = __iflow_slash_commands__.findIndex(c => c.name === name);
  if (index >= 0) {
    __iflow_slash_commands__.splice(index, 1);
    console.log(`[CommandAPI] Unregistered slash command: /${name}`);
    return true;
  }
  return false;
};

/**
 * 获取所有已注册的 TUI slash 命令
 * @returns {Array} 命令列表
 */
global.getSlashCommands = function() {
  return __iflow_slash_commands__.slice();
};

/**
 * 检查是否有已注册的 TUI slash 命令
 * @returns {boolean}
 */
global.hasSlashCommands = function() {
  return __iflow_slash_commands__.length > 0;
};

// ===== CLI 命令注册表 =====
const __iflow_command_registry__ = {
  commands: new Map(),
  // 存储命令以便后续添加
  _registeredCommands: [],

  registerCommand: function(commandDef) {
    if (!commandDef || !commandDef.name) {
      console.warn('[CommandAPI] Invalid command definition: missing name');
      return false;
    }

    const name = commandDef.name;
    const cmd = {
      name: name,
      description: commandDef.description || '',
      builder: commandDef.builder,
      handler: commandDef.handler,
      aliases: commandDef.aliases || [],
      options: commandDef.options || {}
    };

    this.commands.set(name, cmd);
    this._registeredCommands.push(cmd);

    console.log(`[CommandAPI] Registered command: /${name}`);
    return true;
  },

  unregisterCommand: function(name) {
    if (this.commands.has(name)) {
      this.commands.delete(name);
      this._registeredCommands = this._registeredCommands.filter(c => c.name !== name);
      console.log(`[CommandAPI] Unregistered command: /${name}`);
      return true;
    }
    return false;
  },

  getCommands: function() {
    return Array.from(this.commands.values());
  },

  getRegisteredCommands: function() {
    return this._registeredCommands;
  },

  getCommand: function(name) {
    return this.commands.get(name);
  },

  hasCommand: function(name) {
    return this.commands.has(name);
  },

  // 清除已注册的命令列表（用于重新加载）
  clearRegisteredCommands: function() {
    this._registeredCommands = [];
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

// 加载模块
const loader = {
  load: function(target) {
    console.log('[CommandAPI] Command registry loader loaded');

    // 尝试加载用户自定义命令配置
    this.loadCustomCommands();

    // 尝试注入命令到 yargs
    this.injectToYargs();

    // 自动加载依赖此框架的 MOD loader（如 api-command-loader.cjs）
    this.loadDependentLoaders();

    // 返回注册表以便后续使用
    return __iflow_command_registry__;
  },

  loadDependentLoaders: function() {
    // 自动加载 api-command-loader.cjs（如果存在）
    const path = require('path');
    const possiblePaths = [
      path.join(process.cwd(), 'api-command-loader.cjs'),
      path.join(path.dirname(process.execPath), 'api-command-loader.cjs'),
      path.join(__dirname, 'api-command-loader.cjs')
    ];

    for (const loaderPath of possiblePaths) {
      try {
        if (require('fs').existsSync(loaderPath)) {
          const loader = require(loaderPath);
          if (loader && loader.load) {
            loader.load();
            console.log('[CommandAPI] Loaded dependent loader:', path.basename(loaderPath));
          }
          break; // 只加载第一个找到的
        }
      } catch (e) {
        // 静默忽略加载错误
      }
    }
  },

  injectToYargs: function() {
    // 使用 __iflow_command_registry__ 直接获取命令，避免 this 上下文问题
    const registry = __iflow_command_registry__;

    // 尝试多种方式获取 yargs 实例
    let yargsInstance = null;
    let yargsModule = null;

    // 方法1: 尝试从全局对象获取
    if (global.yargs) {
      yargsInstance = global.yargs;
    }

    // 方法2: 尝试 require yargs
    if (!yargsInstance) {
      try {
        yargsModule = require('yargs');
        if (yargsModule && typeof yargsModule === 'function') {
          yargsInstance = yargsModule;
        }
      } catch (e) {
        // yargs 未安装，忽略
      }
    }

    // 方法3: 尝试从 process.argv 获取（yargs 会在解析时修改）
    if (!yargsInstance && global.__yargs) {
      yargsInstance = global.__yargs;
    }

    if (!yargsInstance) {
      // yargs 还未初始化，延迟尝试
      const commands = registry.getRegisteredCommands();
      if (commands.length > 0) {
        console.log('[CommandAPI] yargs not ready yet, queuing commands for later injection');
        // 保存命令到全局，等待 yargs 初始化后注入
        global.__iflow_pending_commands__ = (global.__iflow_pending_commands__ || []).concat(commands);
      }
      return false;
    }

    // 注入命令到 yargs
    const commands = registry.getRegisteredCommands();
    if (commands.length === 0) {
      return true;
    }

    try {
      // 遍历已注册的命令并添加到 yargs
      commands.forEach(cmd => {
        try {
          // 使用 command() 方法注册命令
          if (yargsInstance.command) {
            // 如果 yargsInstance 是函数（yargs 模块），先创建实例
            const y = typeof yargsInstance === 'function' ? yargsInstance() : yargsInstance;

            if (cmd.builder) {
              // 命令有 builder（子命令）
              y.command(cmd.name, cmd.description, cmd.builder, cmd.handler, cmd.aliases);
            } else {
              // 简单命令
              y.command(cmd.name, cmd.description, cmd.handler, cmd.aliases);
            }

            console.log(`[CommandAPI] Injected command /${cmd.name} to yargs`);
          }
        } catch (e) {
          console.warn(`[CommandAPI] Failed to inject command /${cmd.name}:`, e.message);
        }
      });

      // 更新全局 yargs
      global.yargs = yargsInstance;
      return true;
    } catch (e) {
      console.warn('[CommandAPI] Failed to inject commands to yargs:', e.message);
      return false;
    }
  },

  loadCustomCommands: function() {
    // 尝试多种路径
    const possiblePaths = [
      // Windows 用户目录
      path.join(process.env.USERPROFILE || '', '.iflow', 'commands.json'),
      // Unix/Linux 用户目录
      path.join(process.env.HOME || '', '.iflow', 'commands.json'),
      // 当前工作目录
      path.join(process.cwd(), 'commands.json')
    ];

    for (const configPath of possiblePaths) {
      try {
        if (fs.existsSync(configPath)) {
          const content = fs.readFileSync(configPath, 'utf-8');
          const config = JSON.parse(content);

          if (config.commands && Array.isArray(config.commands)) {
            config.commands.forEach(cmd => {
              if (cmd.name && cmd.handler) {
                global.registerCommand(cmd);
              }
            });
            console.log(`[CommandAPI] Loaded ${config.commands.length} custom commands from ${configPath}`);
            return; // 成功加载后退出
          }
        }
      } catch (e) {
        console.warn(`[CommandAPI] Failed to load custom commands from ${configPath}:`, e.message);
      }
    }
  },

  // 获取用于注入到 yargs 的命令
  getCommandsForInjection: function() {
    return __iflow_command_registry__.getRegisteredCommands();
  }
};

// 导出模块
module.exports = loader;

// 同时导出全局 API 以便直接访问
module.exports.registry = __iflow_command_registry__;
module.exports.getCommandsForInjection = function() {
  return __iflow_command_registry__.getRegisteredCommands();
};

// ===== 全局 yargs Hook =====
// Hook yargs 的 command 方法，自动注入待处理的命令
function setupYargsHook() {
  try {
    const yargs = require('yargs');
    if (!yargs || !yargs.command) return;

    // 保存原始 command 方法
    const originalCommand = yargs.command.bind(yargs);

    // Hook command 方法
    yargs.command = function(cmd, description, builder, handler, aliases) {
      // 先注入待处理的命令
      if (global.__iflow_pending_commands__ && global.__iflow_pending_commands__.length > 0) {
        const pending = global.__iflow_pending_commands__.slice();
        global.__iflow_pending_commands__ = [];

        pending.forEach(pendingCmd => {
          try {
            if (pendingCmd.builder) {
              originalCommand(pendingCmd.name, pendingCmd.description, pendingCmd.builder, pendingCmd.handler, pendingCmd.aliases);
            } else {
              originalCommand(pendingCmd.name, pendingCmd.description, pendingCmd.handler, pendingCmd.aliases);
            }
            console.log(`[CommandAPI] Auto-injected pending command /${pendingCmd.name}`);
          } catch (e) {
            console.warn(`[CommandAPI] Failed to auto-inject command /${pendingCmd.name}:`, e.message);
          }
        });
      }

      // 调用原始方法
      return originalCommand(cmd, description, builder, handler, aliases);
    };

    // 保存到全局以便后续使用
    global.yargs = yargs;
    console.log('[CommandAPI] yargs hook installed (early)');
  } catch (e) {
    // yargs 可能还未安装，忽略
  }
}

// ===== 备用：process.argv 监控 =====
function setupArgvMonitor() {
  // 定期检查 process.argv，看是否有我们的命令
  const checkInterval = setInterval(function() {
    const args = process.argv;
    if (!args || args.length < 2) return;

    // 检查是否包含我们的命令（如 /api 或 --api）
    const hasOurCommand = args.some(function(arg) {
      return arg === '/api' || arg === 'api' || arg.startsWith('--api') || arg.startsWith('-a');
    });

    if (hasOurCommand && global.__iflow_pending_commands__ && global.__iflow_pending_commands__.length > 0) {
      // 有待处理命令，尝试注入
      clearInterval(checkInterval);
      try {
        const yargs = require('yargs');
        if (yargs && yargs.command) {
          const pending = global.__iflow_pending_commands__.slice();
          global.__iflow_pending_commands__ = [];

          pending.forEach(function(pendingCmd) {
            try {
              if (pendingCmd.builder) {
                yargs.command(pendingCmd.name, pendingCmd.description, pendingCmd.builder, pendingCmd.handler, pendingCmd.aliases);
              } else {
                yargs.command(pendingCmd.name, pendingCmd.description, pendingCmd.handler, pendingCmd.aliases);
              }
              console.log(`[CommandAPI] Auto-injected command /${pendingCmd.name} via argv monitor`);
            } catch (e) {}
          });
        }
      } catch (e) {}
    }
  }, 100);

  // 30秒后停止检查
  setTimeout(function() {
    clearInterval(checkInterval);
  }, 30000);
}

// 立即尝试设置 hook
if (typeof require !== 'undefined') {
  setupYargsHook();
  setupArgvMonitor();
}

console.log('[CommandAPI] Command registry initialized');