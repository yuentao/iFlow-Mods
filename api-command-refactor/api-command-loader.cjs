// api-command-loader.cjs
// API Profile 命令加载器模块（简化版，无阻塞）
// 提供 /api 命令用于切换 API Profile
// 支持两种模式：TUI slash 命令 和 CLI 命令

const path = require('path');
const fs = require('fs');

// ===== 安全检查：避免重复加载 =====
if (global.__apiCommandLoaderLoaded) {
  console.log('[ApiCommand] Already loaded, skipping...');
  module.exports = { load: function() {} };
  return;
}
global.__apiCommandLoaderLoaded = true;

// ===== API Profile 管理模块 =====

const ApiProfileManager = {
  getSettingsPath: function() {
    const homeDir = process.env.USERPROFILE || process.env.HOME || process.env.APPDATA;
    const iflowDir = path.join(homeDir, '.iflow');
    return path.join(iflowDir, 'settings.json');
  },

  readSettings: function() {
    const settingsPath = this.getSettingsPath();
    try {
      if (fs.existsSync(settingsPath)) {
        const content = fs.readFileSync(settingsPath, 'utf-8');
        return JSON.parse(content);
      }
    } catch (e) {
      // 静默失败
    }
    return {};
  },

  readProfiles: function() {
    const settings = this.readSettings();
    return settings.apiProfiles || {};
  },

  getCurrentProfileName: function() {
    const settings = this.readSettings();
    return settings.currentApiProfile || null;
  },

  saveSelection: function(profileName, profileData) {
    try {
      const settingsPath = this.getSettingsPath();
      let settings = this.readSettings();
      settings.currentApiProfile = profileName;
      settings.baseUrl = profileData.baseUrl;
      settings.apiKey = profileData.apiKey;
      settings.modelName = profileData.modelName;
      settings.selectedAuthType = profileData.selectedAuthType || 'openai-compatible';
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      return true;
    } catch (e) {
      return false;
    }
  }
};

global.ApiProfileManager = ApiProfileManager;

// ===== 命令处理函数 =====

function handleSlashCommand(args) {
  const profiles = ApiProfileManager.readProfiles();
  const currentName = ApiProfileManager.getCurrentProfileName();

  const isList = args.includes('--list') || args.includes('-l') || args.includes('list');
  const profileArg = args.find(function(a) { return a.startsWith('--profile=') || a.startsWith('-p='); });
  let profileName = profileArg ? profileArg.split('=')[1] : null;

  if (!profileName) {
    const nonFlagArg = args.find(function(a) { return !a.startsWith('-') && a !== 'api' && a !== '/api'; });
    if (nonFlagArg) profileName = nonFlagArg;
  }

  if (isList) {
    console.log('\n=== API Profiles ===');
    const profileNames = Object.keys(profiles);
    if (profileNames.length === 0) {
      console.log('  (未配置 API Profile)');
      console.log('\n请使用 iFlow Settings Editor 添加 API Profile');
    } else {
      profileNames.forEach(function(name) {
        const marker = name === currentName ? ' *' : '';
        console.log('  ' + name + marker);
      });
      console.log('\n当前: ' + (currentName || '未设置'));
    }
    console.log('');
    return { success: true };
  } else if (profileName) {
    const profile = profiles[profileName];
    if (!profile) {
      console.error('Profile "' + profileName + '" 不存在');
      console.log('使用 /api --list 查看可用 Profile');
      return { success: false, error: 'Profile not found' };
    }

    const success = ApiProfileManager.saveSelection(profileName, profile);
    if (success) {
      console.log('已切换到 API Profile: ' + profileName);
      console.log('  Base URL: ' + profile.baseUrl);
      console.log('  Model: ' + profile.modelName);
      return { success: true };
    } else {
      console.error('切换失败');
      return { success: false, error: 'Save failed' };
    }
  } else {
    console.log('API Profile 管理');
    console.log('');
    console.log('用法:');
    console.log('  /api --list          列出所有 API Profile');
    console.log('  /api <profile-name>  切换到指定 Profile');
    console.log('');
    console.log('当前: ' + (currentName || '未设置'));
    console.log('');
    return { success: true };
  }
}

function handleCliCommand(argv) {
  const profiles = ApiProfileManager.readProfiles();
  const currentName = ApiProfileManager.getCurrentProfileName();

  if (argv.list) {
    console.log('\n=== API Profiles ===');
    const profileNames = Object.keys(profiles);
    if (profileNames.length === 0) {
      console.log('  (未配置 API Profile)');
      console.log('\n请使用 iFlow Settings Editor 添加 API Profile');
    } else {
      profileNames.forEach(function(name) {
        const marker = name === currentName ? ' *' : '';
        console.log('  ' + name + marker);
      });
      console.log('\n当前: ' + (currentName || '未设置'));
    }
    console.log('');
  } else if (argv.profile) {
    const profile = profiles[argv.profile];
    if (!profile) {
      console.error('Profile "' + argv.profile + '" 不存在');
      console.log('使用 /api --list 查看可用 Profile');
      process.exit(1);
    }
    const success = ApiProfileManager.saveSelection(argv.profile, profile);
    if (success) {
      console.log('已切换到 API Profile: ' + argv.profile);
      console.log('  Base URL: ' + profile.baseUrl);
      console.log('  Model: ' + profile.modelName);
    } else {
      console.error('切换失败');
      process.exit(1);
    }
  } else {
    console.log('API Profile 管理');
    console.log('');
    console.log('用法:');
    console.log('  /api --list              列出所有 API Profile');
    console.log('  /api --profile <名称>    切换到指定 Profile');
  }
}

// ===== 命令注册 =====
module.exports = {
  load: function(target) {
    console.log('[ApiCommand] Loading API command loader...');

    // 注册 TUI slash 命令
    if (typeof global.registerSlashCommand === 'function') {
      global.registerSlashCommand({
        name: 'api',
        description: '切换 API Profile',
        altNames: ['a'],
        handler: function(args) {
          return handleSlashCommand(args);
        }
      });
      console.log('[ApiCommand] Registered TUI slash command: /api');
    }

    // 注册 CLI 命令
    if (typeof global.registerCommand === 'function') {
      global.registerCommand({
        name: 'api',
        description: '切换 API Profile',
        aliases: ['a'],
        builder: function(yargs) {
          return yargs
            .option('profile', { alias: 'p', describe: 'API Profile 名称', type: 'string' })
            .option('list', { alias: 'l', describe: '列出所有 API Profile', type: 'boolean', default: false });
        },
        handler: function(argv) {
          return handleCliCommand(argv);
        }
      });
      console.log('[ApiCommand] Registered CLI command: api');
    }

    console.log('[ApiCommand] API command loader initialized');
    return target;
  }
};