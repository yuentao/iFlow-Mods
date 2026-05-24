# API 命令重构计划

## 一、背景与目标

### 1.1 项目背景

iFlow CLI 是一款终端 AI 编程助手，目前支持多种认证方式，包括：

- **iFlow 官方认证**（`LOGIN_WITH_IFLOW`）
- **AONE 认证**（`LOGIN_WITH_AONE`）
- **OpenAI Compatible API**（通过 `baseUrl` + `apiKey` 配置）

当前 iFlow 使用单一 API 端点，用户需要在配置文件中手动修改 `baseUrl` 和 `apiKey` 才能切换不同的 API 服务商。

### 1.2 目标

实现 `/api` 命令，提供交互式 API Profile 切换功能：

```
用户在 TUI 输入 /api
  → 显示已保存的 API Profile 列表
  → 用户选择 Profile
  → 保存选择到 settings.json
```

> **重要**：仅实现 **选择** 功能（从已有 Profile 中选择）。Profile 的 **管理**（新增/编辑/删除）由外部工具 iFlow-Settings-Editor-GUI 负责。

---

## 二、配置文件格式

根据 `~/.iflow/settings.json` 的实际结构：

```json
{
  "selectedAuthType": "openai-compatible",
  "baseUrl": "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2",
  "apiKey": "9ec48e443e1821f8413230ae61a4be6b:OTY3OTg4ODkwYjEwMjVkMTJiMmU1OGFl",
  "modelName": "astron-code-latest",
  "language": "zh-CN",
  "currentApiProfile": "讯飞",
  "apiProfiles": {
    "火山": {
      "selectedAuthType": "openai-compatible",
      "apiKey": "07aa1fc8-cb34-4420-8537-8d8366d31146",
      "baseUrl": "https://ark.cn-beijing.volces.com/api/coding/v3",
      "modelName": "glm-5.1",
      "tokensLimit": 200000,
      "expiryDays": 0,
      "_lastModified": "2026-05-24T15:25:51.172Z"
    },
    "讯飞": {
      "selectedAuthType": "openai-compatible",
      "apiKey": "9ec48e443e1821f8413230ae61a4be6b:OTY3OTg4ODkwYjEwMjVkMTJiMmU1OGFl",
      "baseUrl": "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2",
      "modelName": "astron-code-latest",
      "tokensLimit": 200000,
      "expiryDays": 31,
      "expiryStartDate": "2026-05-13T08:03:57.032Z",
      "_lastModified": "2026-05-24T12:50:36.457Z"
    }
  },
  "apiProfilesOrder": ["讯飞", "火山"]
}
```

### 关键字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `apiProfiles` | Object | Profile 集合，键为 Profile 名称 |
| `currentApiProfile` | String | 当前激活的 Profile 名称 |
| `apiProfilesOrder` | Array | Profile 显示顺序（可选）|
| `selectedAuthType` | String | 认证类型（固定为 `openai-compatible`）|
| `baseUrl` | String | 当前 API 端点 |
| `apiKey` | String | 当前 API 密钥 |
| `modelName` | String | 当前模型名称 |

> **核心逻辑**：切换 Profile 时更新 `currentApiProfile`、`baseUrl`、`apiKey`、`modelName` 四个字段。

---

## 三、实现模式

使用 `type: "patch"` 模式（依赖 command-api-refactor MOD）

### 3.1 依赖关系

本 MOD 依赖 **command-api-refactor** MOD，需要先安装该 MOD。

依赖关系：
- **command-api-refactor**: 提供 `registerCommand` 全局 API
- **api-command-refactor**: 使用 API 注册 `/api` 命令

### 3.2 实现方式

通过 patch 方式注入加载器模块，调用 `global.registerCommand()` 注册 `/api` 命令，无需整体替换源码。

---

## 四、需要修改的位置

### 1. 命令注册 (~6203行, $3t 函数)

在现有命令中添加 `/api` 命令：

```javascript
// 在现有 .commands({...}) 中添加
"api": {
  description: "切换 API Profile",
  alias: "a",
  action: async () => {
    // 调用 rZi 组件
  }
}
```

### 2. API Profile 管理函数

**位置**: ~12830996 (AJ 函数附近)

新增函数：
- `readApiProfiles()` - 读取 apiProfiles 数组
- `getActiveProfile()` - 通过匹配 baseUrl/apiKey 确定当前 Profile
- `saveApiProfileSelection(profile)` - 保存用户选择的 Profile

### 3. rZi 组件 (新建)

**位置**: 约 13203308 (参考 rYi 位置)

功能：
- 显示 Profile 列表（当前激活的 Profile 标记选中状态）
- 处理选择逻辑
- 调用保存函数

---

## 五、详细实现方案

### 5.1 加载器模块（patch 方式）

```javascript
// api-command-loader.cjs
module.exports = {
  load: function(target) {
    // 检查 command-api-refactor 是否已安装
    if (typeof global.registerCommand !== 'function') {
      console.warn('[ApiCommand] command-api-refactor MOD not installed. Please install it first.');
      return;
    }

    // 注册 /api 命令
    global.registerCommand({
      name: 'api',
      description: '切换 API Profile',
      builder: (yargs) => {
        return yargs
          .option('profile', {
            alias: 'p',
            describe: 'API Profile 名称',
            type: 'string'
          })
          .option('list', {
            alias: 'l',
            describe: '列出所有 API Profile',
            type: 'boolean',
            default: false
          });
      },
      handler: async (argv) => {
        if (argv.list) {
          // 列出所有 Profile
          const profiles = ApiProfileManager.readProfiles();
          const currentName = ApiProfileManager.getCurrentProfileName();

          console.log('\n=== API Profiles ===');
          Object.entries(profiles).forEach(([name, data]) => {
            const marker = name === currentName ? ' *' : '';
            console.log(`  ${name}${marker}`);
          });
          console.log(`\n当前: ${currentName || '未设置'}`);
        } else if (argv.profile) {
          // 切换到指定 Profile
          const profiles = ApiProfileManager.readProfiles();
          const profile = profiles[argv.profile];

          if (!profile) {
            console.error(`Profile "${argv.profile}" 不存在`);
            process.exit(1);
          }

          const success = ApiProfileManager.saveSelection(argv.profile, profile);
          if (success) {
            console.log(`已切换到 API Profile: ${argv.profile}`);
          } else {
            console.error('切换失败');
            process.exit(1);
          }
        } else {
          // 显示交互式选择 UI
          // 使用 rZi 组件（需要 TUI 环境）
          console.log('请使用 /api --list 查看可用 Profile');
          console.log('或使用 /api --profile <name> 切换 Profile');
        }
      }
    });

    console.log('[ApiCommand] /api command registered');
    return target;
  }
};
```

### 5.2 API Profile 管理模块（与之前相同）

```javascript
// ===== API Profile 管理模块 =====

const ApiProfileManager = {
  // 读取 Profile 列表（对象形式）
  readProfiles: function() {
    try {
      const path = wp.getGlobalSettingsPath();
      if (!fs.existsSync(path)) return {};
      const settings = JSON.parse(fs.readFileSync(path, "utf-8"));
      return settings.apiProfiles || {};
    } catch (e) {
      console.warn("[ApiProfile] Failed to read profiles:", e.message);
      return {};
    }
  },

  // 读取当前激活的 Profile 名称
  getCurrentProfileName: function() {
    try {
      const path = wp.getGlobalSettingsPath();
      if (!fs.existsSync(path)) return null;
      const settings = JSON.parse(fs.readFileSync(path, "utf-8"));
      return settings.currentApiProfile || null;
    } catch (e) {
      return null;
    }
  },

  // 读取当前 Profile 的完整配置
  getCurrentProfile: function() {
    const profiles = this.readProfiles();
    const currentName = this.getCurrentProfileName();
    return currentName ? profiles[currentName] : null;
  },

  // 保存选择 - 更新多个字段
  saveSelection: function(profileName, profileData) {
    try {
      const path = wp.getGlobalSettingsPath();
      let settings = {};
      if (fs.existsSync(path)) {
        settings = JSON.parse(fs.readFileSync(path, "utf-8"));
      }

      // 更新当前 Profile 名称
      settings.currentApiProfile = profileName;

      // 更新顶层配置（保持向后兼容）
      settings.baseUrl = profileData.baseUrl;
      settings.apiKey = profileData.apiKey;
      settings.modelName = profileData.modelName;
      settings.selectedAuthType = profileData.selectedAuthType || "openai-compatible";

      fs.writeFileSync(path, JSON.stringify(settings, null, 2), "utf-8");
      console.log("[ApiProfile] Switched to profile:", profileName);
      return true;
    } catch (e) {
      console.warn("[ApiProfile] Failed to save selection:", e.message);
      return false;
    }
  }
};
```

### 5.2 rZi 组件

```javascript
// rZi 组件：API Profile 选择对话框
const rZi = ({ onSelect, onCancel }) => {
  const [profiles, setProfiles] = useState({});
  const [currentProfileName, setCurrentProfileName] = useState(null);

  // 加载 Profile 列表和当前激活的 Profile
  useEffect(() => {
    const loadedProfiles = ApiProfileManager.readProfiles();
    const currentName = ApiProfileManager.getCurrentProfileName();
    setProfiles(loadedProfiles);
    setCurrentProfileName(currentName);
  }, []);

  // 转换为 yl 需要的数组格式
  const items = Object.entries(profiles).map(([name, data]) => ({
    label: `${name}${name === currentProfileName ? " (当前)" : ""}`,
    value: { name, ...data }
  }));

  // 选择处理
  const handleSelect = async (profile) => {
    const success = ApiProfileManager.saveSelection(profile.name, profile);
    if (success && onSelect) {
      onSelect(profile);
    }
  };

  // 渲染选择列表
  return yl({
    items: items,
    onSelect: handleSelect,
    onCancel: onCancel
  });
};
```

---

## 六、实现步骤

1. **读取 settings.json** - 从 `~/.iflow/settings.json` 读取 apiProfiles 对象和 currentApiProfile
2. **确定当前 Profile** - 读取 currentApiProfile 字段获取当前激活的 Profile 名称
3. **显示选择 UI** - 使用 yl 组件显示列表,当前激活的 Profile 标记 "(当前)" 状态
4. **保存选择** - 用户选择后,更新 currentApiProfile、baseUrl、apiKey、modelName 四个字段

---

## 七、现有代码参考

### 7.1 设置系统

- `wp.getGlobalSettingsPath()`：获取全局设置路径 `~/.iflow/settings.json`
- `wp.getWorkspaceSettingsPath()`：获取工作区设置路径

### 7.2 现有组件参考

- **rYi 组件**（~行 13203308）：模型选择对话框，可作为 UI 参考
- **yl 组件**：列表选择组件
- **Xio.handleModelSelect**（~行 13332126）：保存逻辑参考

---

## 八、错误处理

| 场景 | 处理方式 |
|------|----------|
| settings.json 不存在 | 使用默认空列表 |
| settings.json 格式错误 | 打印警告，使用空列表 |
| apiProfiles 为空 | 显示"未配置 API Profile"提示 |
| 未匹配到当前 Profile | 不标记任何 Profile 为选中状态 |
| 写入失败 | 打印警告，不阻塞流程 |

---

## 九、向后兼容性

保留现有 `baseUrl` 和 `apiKey` 字段，Profile 切换时直接更新这两个字段。

---

## 十、日志输出

使用 `[ApiProfile]` 前缀：

```javascript
console.log("[ApiProfile] Loaded profiles:", profiles.length);
console.log("[ApiProfile] Active profile:", activeProfile?.name);
console.log("[ApiProfile] Switched to profile:", profile.name);
console.warn("[ApiProfile] Failed to save selection:", error.message);
```