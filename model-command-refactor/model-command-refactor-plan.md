# iFlow CLI `/model` 命令重构方案

## 一、当前状态分析

### 1.1 现状

`/model` 在 TUI 中已有一个**交互式模型选择对话框**，包含两种模式：

1. **选择模式** - 使用 `yl` 选择组件展示模型列表，用户可上下选择
2. **输入模式** - 使用 `Ty` 文本输入框手动输入模型名

**组件函数**: `rYi` (`iflow.js.original` ~行 13203308)

**参数**:
- `onSelect` (t) - 选择模型后的回调
- `onCancel` (e) - 取消回调
- `settings` (r) - 设置对象
- `initialErrorMessage` (n) - 初始错误信息

**模型数据来源** (在 `rYi` 内部):
- `AJ()` 函数 (~行 12830996): 从 iFlow 认证系统 (`u2e`) 获取模型列表，并为 `glm-4.7` 和 `iFlow-ROME-30BA3B` 添加特殊标签
- `rgt` 变量 (~行 12831211): 硬编码的备用列表:
  - Qwen3-Coder → `ide-whale/qwen3-coder`
  - Claude-4-Sonnet → `ide-idealab/claude4-sonnet`
  - DeepSeek-V3.2-Whale → `ide-whale/deepseek-v3.2-exp`
  - Kimi-K2 → `ide-whale/kimi_k2`

**选择逻辑**:
```
s === "model-select" 时:
  ├── 认证类型为 AONE/LOGIN_WITH_AONE → 从 AONE API 获取模型
  ├── 认证类型为 IFLOW/LOGIN_WITH_IFLOW → 调用 AJ() 获取模型
  └── 其他情况 → 使用 rgt 硬编码列表
```

### 1.2 模型保存逻辑 (已存在，可沿用)

**`Xio` 函数** (~行 13332126) 提供 `handleModelSelect`:

```javascript
handleModelSelect: async (modelName, source) => {
  t.setValue(source, "modelName", modelName);  // 保存到设置状态
  let authType = t.merged.selectedAuthType;
  authType && await r.refreshAuth(authType, {   // 刷新认证
    apiKey: t.merged.apiKey,
    baseUrl: t.merged.baseUrl,
    modelName: modelName,
    searchApiKey: t.merged.searchApiKey
  });
  // 关闭对话框
}
```

**调用链**:
```
rYi 组件 (模型选择)
  → onSelect=$9 (handleModelSelect)
  → t.setValue(source, "modelName", modelName)  // 保存模型
  → r.refreshAuth(authType, {modelName, ...})    // 刷新认证
```

### 1.3 CLI 层面的 `--model` 选项

`/model` 同时也是 CLI 的 `--model` / `-m` **选项**。

**定义位置**: `iflow.js.original` ~第6203行 (`$3t()` 函数)

```javascript
.option("model", {
  alias: "m",
  type: "string",
  description: "Model",
  default: up.env.modelName || up.env.MODELNAME || up.env.MODEL_NAME || 
           up.env.model_name || up.env.model || up.env.MODEL
})
```

**默认值来源** (按优先级): `modelName` > `MODELNAME` > `MODEL_NAME` > `model_name` > `model` > `MODEL`

### 1.4 设置系统

**设置文件路径**:
- 全局: `~/.iflow/settings.json` (`wp.getGlobalSettingsPath()`)
- 工作区: `<project>/.iflow/settings.json` (`wp.getWorkspaceSettingsPath()`)

**设置加载**: `Tbo()` 函数仅读取 `language` 字段，未读取 `baseUrl`。

**注意**: 模型名保存已由 `Xio.handleModelSelect` 中的 `t.setValue(source, "modelName", modelName)` 处理，无需额外实现。只需要读取 `baseUrl` 来构造 API 请求地址。

### 1.5 关键代码位置

| 组件 | 位置 (行号) | 说明 |
|------|------------|------|
| `$3t()` 主入口 | ~6203 | CLI 参数解析、子命令注册、启动流程 |
| `--model` 选项 | ~6203 | 模型选项定义 |
| `gJ()` Agent创建 | ~6400 | 创建 Agent 实例，使用 `n.model \|\| t.modelName \|\| Np` |
| `Tbo()` 设置加载 | ~1592292 | 读取 settings.json，仅提取 `language` |
| `wp` 路径工具类 | ~1146214 | 提供 `getGlobalSettingsPath()` 等方法 |
| `YRe`/`pdo` 渲染 | ~640109 | Ink 渲染函数 |
| `tCr` 主组件 | ~14182806 | Ink/React 主应用组件 |
| `AJ()` 模型列表 | ~12830996 | 从 iFlow 认证获取模型列表 |
| `rgt` 硬编码列表 | ~12831211 | 备用模型列表 (4个模型) |
| `rYi` 组件 | ~13203308 | 交互式模型选择对话框 |
| `Xio` 函数 | ~13332126 | 对话框状态管理 + 模型保存逻辑 |
| `nYi` 验证对话框 | ~13205800 | 模型验证/偏好选择对话框 |

---

## 二、目标行为

### 2.1 核心变更

**核心思路**: 利用现有的 `rYi` 组件和 `Xio` 保存逻辑，仅修改 `rYi` 内部的模型数据源。

```
用户在 TUI 输入 /model
  → 读取 ~/.iflow/settings.json 中的 baseUrl
  → GET {baseUrl}/models (Bearer 认证)
  → 将 API 返回的模型列表注入现有 rYi 组件
  → 用户交互选择
  → 沿用现有 Xio.handleModelSelect 保存逻辑
```

### 2.2 数据流

```
settings.json (读取)
  ├── baseUrl: "https://token.sensenova.cn/v1"
  └── modelName: (可选)

模型列表获取:
  GET {baseUrl}/models
  Headers: Authorization: Bearer {apiKey}

用户选择:
  现有 rYi 组件 → 选择模型 → 沿用 Xio.handleModelSelect 保存

settings.json (写入):
  ├── baseUrl: "https://token.sensenova.cn/v1"
  ├── modelName: "sensenova-6.7-flash-lite"  (用户选择的模型)
  └── language: "zh"
```

---

## 三、详细实现方案

### 3.1 读取 baseUrl

**文件**: `iflow.js.original`

**新增 `readBaseUrl()` 函数**，仅从 settings.json 读取 `baseUrl` 字段:

```javascript
function readBaseUrl() {
  try {
    const path = wp.getGlobalSettingsPath();
    if (fs.existsSync(path)) {
      const settings = JSON.parse(fs.readFileSync(path, "utf-8"));
      return settings.baseUrl || "";
    }
  } catch (e) {
    console.debug("Failed to read baseUrl:", e.message);
  }
  return "";
}
```

**settings.json 中需要的字段**:
```json
{
  "baseUrl": "https://token.sensenova.cn/v1"
}
```

**注意**: 模型名 (`modelName`) 的保存由 `Xio.handleModelSelect` 中的 `t.setValue(source, "modelName", modelName)` 处理，无需额外实现。`apiKey` 从 `r.merged.apiKey` 获取，也无需额外读取。

### 3.2 模型列表获取函数

新增 `fetchModelList()` 函数，用于从 API 获取模型列表:

```javascript
async function fetchModelList(baseUrl, apiKey) {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.data || [];
}
```

**已确认的 API 响应格式** (`https://token.sensenova.cn/v1/models`):

```json
{
  "data": [
    {
      "id": "sensenova-6.7-flash-lite",
      "name": "sensenova-6.7-flash-lite",
      "created": 1777392000,
      "input_modalities": ["text", "image"],
      "output_modalities": ["text"],
      "context_length": 262144,
      "max_output_length": 65536,
      "pricing": {
        "prompt": "0",
        "completion": "0",
        "image": "0",
        "request": "0",
        "input_cache_read": "0"
      },
      "supported_sampling_parameters": ["temperature", "stop"],
      "supported_features": ["tools", "json_mode", "reasoning"],
      "description": "SenseNova 6.7 Flash-Lite is a lightweight multimodal agent model...",
      "openrouter": { "slug": "sensenova/sensenova-6.7-flash-lite" },
      "datacenters": [{ "country_code": "CN" }]
    }
  ]
}
```

### 3.3 修改现有 rYi 组件的数据源

**位置**: `iflow.js.original` ~行 13203308

**当前逻辑** (需要修改的部分):
```javascript
// 当前: 根据认证类型选择数据源
s === "model-select" && (
  r.merged.selectedAuthType === Kt.AONE || 
  r.merged.selectedAuthType === Kt.LOGIN_WITH_AONE
) ? /* AONE API 获取 */ : 
s === "model-select" && (
  r.merged.selectedAuthType === Kt.IFLOW || 
  r.merged.selectedAuthType === Kt.LOGIN_WITH_IFLOW
) ? m([...AJ()]) : m([...rgt])
```

**改为**: 优先从 `{baseUrl}/models` API 获取，失败时回退到原有逻辑:

```javascript
// 在 rYi 的 useEffect 中新增 API 获取分支
s === "model-select" && (
  // 新增: 如果有 baseUrl，优先从 API 获取
  r.merged.baseUrl && r.merged.apiKey
) ? await loadModelsFromApi(r.merged.baseUrl, r.merged.apiKey, m, p) :
// 原有逻辑保持不变作为回退
s === "model-select" && (
  r.merged.selectedAuthType === Kt.AONE || 
  r.merged.selectedAuthType === Kt.LOGIN_WITH_AONE
) ? /* AONE API 获取 */ : 
s === "model-select" && (
  r.merged.selectedAuthType === Kt.IFLOW || 
  r.merged.selectedAuthType === Kt.LOGIN_WITH_IFLOW
) ? m([...AJ()]) : m([...rgt])
```

辅助函数:
```javascript
async function loadModelsFromApi(baseUrl, apiKey, setModels, getFallback) {
  try {
    const models = await fetchModelList(baseUrl, apiKey);
    const items = models.map(m => ({
      label: m.name || m.id,
      value: m.id
    }));
    if (items.length > 0) {
      setModels(items);
      return;
    }
  } catch (e) {
    console.warn("Failed to fetch models from API:", e.message);
  }
  // API 失败时使用回退
  setModels(getFallback());
}
```

### 3.4 模型保存逻辑 (无需修改)

**现有 `Xio.handleModelSelect` 已包含完整保存逻辑**，无需修改:

```javascript
handleModelSelect: async (modelName, source) => {
  t.setValue(source, "modelName", modelName);  // 保存到设置状态
  let authType = t.merged.selectedAuthType;
  authType && await r.refreshAuth(authType, {   // 刷新认证
    apiKey: t.merged.apiKey,
    baseUrl: t.merged.baseUrl,
    modelName: modelName,
    searchApiKey: t.merged.searchApiKey
  });
  // 关闭对话框
}
```

### 3.5 模型选项优先级 (无需修改)

`--model` 选项的默认值逻辑**不需要修改**。TUI 中的模型名已通过 `Xio.handleModelSelect` → `t.setValue(source, "modelName", modelName)` 保存到应用状态，`--model` 选项仅用于 CLI 非交互模式，保持现有逻辑即可。

---

## 四、文件修改清单

### 修改 1: 新增 `readBaseUrl()` 函数

**位置**: `iflow.js.original` ~在 `AJ()` 函数附近 (行 12830996)

**新增**:
- `readBaseUrl()` - 从 `~/.iflow/settings.json` 读取 `baseUrl` 字段
- `fetchModelList(baseUrl, apiKey)` - 从 API 获取模型列表
- `normalizeModelList(response)` - 响应标准化
- `loadModelsFromApi(baseUrl, apiKey, setModels, getFallback)` - 加载并回退

### 修改 2: 修改 `rYi` 组件的数据源

**位置**: `iflow.js.original` ~行 13203308

**变更**:
- 在 useEffect 的模型加载逻辑中，新增 API 获取分支
- 保留原有 `AJ()`/`rgt` 作为回退方案

---

## 五、API 响应格式适配

### 5.1 已确认的 API 响应格式

```json
{
  "data": [
    {
      "id": "sensenova-6.7-flash-lite",
      "name": "sensenova-6.7-flash-lite",
      "context_length": 262144,
      "max_output_length": 65536,
      "supported_features": ["tools", "json_mode", "reasoning"],
      "pricing": { "prompt": "0", "completion": "0" }
    }
  ]
}
```

### 5.2 格式适配函数

```javascript
function normalizeModelList(response) {
  if (response && response.data && Array.isArray(response.data)) return response.data;
  if (Array.isArray(response)) return response;
  return [];
}
```

### 5.3 认证信息获取

API Key 的获取优先级:
1. `settings.json` 中的 `apiKey` 字段
2. `IFLOW_API_KEY` 环境变量
3. 已有的 iFlow 认证令牌 (通过 `e.merged` 对象)

---

## 六、实施步骤

### Phase 1: 模型 API 获取
1. 实现 `readBaseUrl()` - 从 settings.json 读取 baseUrl
2. 实现 `fetchModelList(baseUrl, apiKey)` - 从 API 获取模型列表
3. 实现 `normalizeModelList()` - 响应标准化
4. 实现 `loadModelsFromApi()` - 转换 + 回退函数

### Phase 2: 修改现有 rYi 组件
1. 在 useEffect 的模型加载逻辑中新增 API 获取分支
2. 保留 `AJ()`/`rgt` 作为回退方案
3. 模型保存逻辑 (`Xio.handleModelSelect`) 无需修改

### Phase 3: 测试与验证
1. 测试 API 正常返回时的模型列表展示
2. 测试 API 失败时的回退逻辑
3. 测试模型选择后的持久化 (沿用现有逻辑)
4. 测试 settings.json 中已有 modelName 时的跳过逻辑
5. 测试环境变量覆盖

---

## 七、注意事项

### 7.1 向后兼容性
- 现有 `rYi` 组件的 UI 保持不变
- `AJ()` 和 `rgt` 保留作为回退方案
- `Xio.handleModelSelect` 保存逻辑完全沿用
- `--model` 选项和 `-m` 别名保持不变
- 环境变量读取逻辑保持不变

### 7.2 错误处理
- API 请求失败时回退到现有逻辑 (`AJ()`/`rgt`)
- 不阻塞用户使用，提供清晰的错误提示
- 网络错误时建议检查 baseUrl 和网络连接

### 7.3 安全性
- API Key 建议优先使用环境变量
- 如果存储在 settings.json 中，提醒用户注意文件权限

### 7.4 性能
- API 请求设置 10 秒超时
- 可考虑缓存模型列表，减少重复请求

---

## 八、代码示例汇总

### 8.1 读取 baseUrl

```javascript
// ===== 读取 baseUrl =====

function readBaseUrl() {
  try {
    const path = wp.getGlobalSettingsPath();
    if (fs.existsSync(path)) {
      const settings = JSON.parse(fs.readFileSync(path, "utf-8"));
      return settings.baseUrl || "";
    }
  } catch (e) {
    console.debug("Failed to read baseUrl:", e.message);
  }
  return "";
}
```

### 8.2 模型获取模块

```javascript
// ===== 模型管理 =====

async function fetchModelList(baseUrl, apiKey) {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': 'iFlow-Cli'
    },
    signal: AbortSignal.timeout(10000)
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  const data = await response.json();
  return normalizeModelList(data);
}

function normalizeModelList(response) {
  const rawModels = response?.data && Array.isArray(response.data) 
    ? response.data 
    : Array.isArray(response) ? response : [];
  return rawModels;
}

async function loadModelsFromApi(baseUrl, apiKey, setModels, getFallback) {
  try {
    const models = await fetchModelList(baseUrl, apiKey);
    const items = models.map(m => ({
      label: m.name || m.id,
      value: m.id
    }));
    if (items.length > 0) {
      setModels(items);
      return;
    }
  } catch (e) {
    console.warn(`Failed to fetch models from API: ${e.message}`);
  }
  // API 失败时使用回退
  setModels(getFallback());
}
```

### 8.3 rYi 组件修改

```javascript
// 在 rYi 的 useEffect 中 (~行 13203308)
// 修改模型加载逻辑:

// 当前:
// s === "model-select" && (
//   r.merged.selectedAuthType === Kt.AONE || 
//   r.merged.selectedAuthType === Kt.LOGIN_WITH_AONE
// ) ? /* AONE API 获取 */ : 
// s === "model-select" && (
//   r.merged.selectedAuthType === Kt.IFLOW || 
//   r.merged.selectedAuthType === Kt.LOGIN_WITH_IFLOW
// ) ? m([...AJ()]) : m([...rgt])

// 改为:
// s === "model-select" && (
//   // 新增: 优先从 API 获取
//   r.merged.baseUrl && r.merged.apiKey
// ) ? await loadModelsFromApi(r.merged.baseUrl, r.merged.apiKey, m, p) :
// s === "model-select" && (
//   r.merged.selectedAuthType === Kt.AONE || 
//   r.merged.selectedAuthType === Kt.LOGIN_WITH_AONE
// ) ? /* AONE API 获取 */ : 
// s === "model-select" && (
//   r.merged.selectedAuthType === Kt.IFLOW || 
//   r.merged.selectedAuthType === Kt.LOGIN_WITH_IFLOW
// ) ? m([...AJ()]) : m([...rgt])
```

---

## 九、依赖项

无需新增外部依赖。iFlow CLI 已包含:
- `fetch` (全局可用或通过 polyfill)
- `fs` (Node.js 内置)
- `path` (Node.js 内置)
- `Ink` + `React` (已用于终端 UI 渲染)
- `yl` 选择组件 (已用于 rYi)
- `Ty` 文本输入组件 (已用于 rYi)
- `Xio.handleModelSelect` 保存逻辑 (已存在，可沿用)

---

## 十、风险与缓解措施

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| API 响应格式不确定 | 模型列表解析失败 | 保留 `AJ()`/`rgt` 作为回退方案 |
| API 请求超时 | 启动延迟 | 设置 10 秒超时，超时后回退 |
| settings.json 写入失败 | 模型选择不持久化 | 捕获异常，仅打印警告 |
| 无网络连接 | 无法获取模型列表 | 回退到现有逻辑，不阻塞使用 |
| baseUrl 配置错误 | 获取模型失败 | 清晰的错误信息，提示检查配置 |
| 大量模型列表 | UI 显示问题 | 利用现有 `yl` 组件的滚动能力 |