# streaming-mode-refactor

将 iFlow CLI 中硬编码的流式响应行为配置化，支持通过外部 JSON 配置文件控制哪些模型使用非流式模式。

## 背景

iFlow CLI 默认对所有模型使用流式响应（`stream: true`）。但部分推理模型（如 o1-preview、o1-mini、o3-mini、o4-mini）不支持流式输出，调用时需要关闭 `stream` 参数。

源码中 `generateContentInternal` 的流式决策逻辑为：

```javascript
s && (p.stream = true, p.stream_options = { include_usage: true });
// ... 后续调用 A2.configureThinkingRequest 或 A2.configureNonThinkingRequest
```

本 MOD 通过 monkey-patch `A2.configureThinkingRequest` 和 `A2.configureNonThinkingRequest`，在这些方法被调用时自动检查模型名称，如果匹配 `nonStreamModels` 规则，则删除请求体中的 `stream` 和 `stream_options` 字段，强制使用非流式模式。

## 功能

1. **nonStreamModels 配置化** — 正则模式匹配模型名称，匹配的模型强制关闭流式
2. **forceNonStream 全局开关** — 设为 `true` 时所有模型都强制非流式
3. **Ctrl+S 快捷键切换** — 在 TUI 中按 `Ctrl+S` 可实时切换当前模型的流式/非流式模式（类似 Tab 切换思考模式）
4. **TUI 状态栏指示器** — 状态栏显示 `streaming: on/off`，首次出现时附带 `(Ctrl+S)` 提示（15 秒后消失）
5. **与 thinking-mode-refactor / multimodal-image-refactor 兼容** — 同一插入点 L950，不同加载目标

### 快捷键切换

与思考模式的 Tab 切换类似，流式模式支持 `Ctrl+S` 快捷键实时切换：

- **Ctrl+S** — 在当前模型支持流式模式切换时，切换流式/非流式状态
- 仅当当前模型匹配 `nonStreamModels` 规则时快捷键生效（即 `isSupported` 为 true）
- 切换为运行时覆盖，不影响配置文件中的默认规则
- 模型切换时自动重置为配置文件的默认状态

### TUI 指示器

状态栏在思考模式指示器旁边显示流式模式状态：

- 流式开启：`| streaming: on`（前景色）
- 流式关闭：`| streaming: off`（黄色）
- 首次出现时附带 `(Ctrl+S)` 提示，15 秒后自动消失（与思考模式提示行为一致）
- 仅当当前模型匹配 `nonStreamModels` 规则时显示指示器

## 配置文件

位置：`~/.iflow/streaming-models.json`

```json
{
  "version": "1.0.0",
  "forceNonStream": false,
  "nonStreamModels": [
    "o1-preview",
    "o1-mini",
    "o1-.*",
    "o3-.*",
    "o4-mini"
  ]
}
```

### 字段说明

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `forceNonStream` | boolean | `false` | 全局开关，`true` 时所有模型强制非流式 |
| `nonStreamModels` | string[] | 见上 | 正则模式数组，匹配的模型强制关闭流式 |

### 匹配逻辑

1. `forceNonStream === true` → 所有模型强制非流式（最高优先级）
2. 模型名匹配 `nonStreamModels` 中的任一正则 → 强制非流式
3. 不匹配 → 保留原始流式行为

### 示例：添加自定义模型

```json
{
  "nonStreamModels": [
    "o1-preview",
    "o1-mini",
    "o1-.*",
    "o3-.*",
    "o4-mini",
    "my-custom-reasoning-model"
  ]
}
```

## 实现原理

### 插入点

L950 的 `},A2=new Dqe});` 处插入逗号表达式：

```javascript
// 原始
},A2=new Dqe});function Pln(){

// 修改后
},A2=new Dqe,require('./streaming-model-loader.cjs').load(A2)});function Pln(){
```

### Monkey-patch 策略

Loader 在 `A2` 上 monkey-patch 了两个方法：

1. **`configureThinkingRequest(modelName, requestBody, thinkingConfig)`**
   - 调用原始方法配置思考模式请求
   - 然后检查 `shouldForceNonStream(modelName)`
   - 如果匹配，删除 `requestBody.stream` 和 `requestBody.stream_options`

2. **`configureNonThinkingRequest(modelName, requestBody)`**
   - 调用原始方法配置非思考模式请求
   - 然后检查 `shouldForceNonStream(modelName)`
   - 如果匹配，删除 `requestBody.stream` 和 `requestBody.stream_options`

### TUI 指示器实现

在 code.js 中做了 3 处额外修改：

1. **StatusBar `qHi` 组件**：添加 `streamingModeState:S` prop，在 `FHi`（思考模式指示器）之后渲染 `SHi`（流式模式指示器），传入 `enabled:S.isEnabled,supported:S.isSupported`

2. **`SHi` 组件**：流式模式指示器组件（与 `FHi` 结构一致），接收 `{enabled, supported}` props：
   - `supported` 为 true 时渲染指示器
   - `enabled` 为 true 显示 `streaming: on`（前景色），false 显示 `streaming: off`（黄色）
   - 首次显示时附带 `(Ctrl+S)` 提示，15 秒后自动消失

3. **主 App**：在 `E7=uio(...)` 之后创建流式模式 hook（类似 `uio`）：
   ```javascript
   sMs = (() => {
     let isSupported = A2.isStreamingModeSupported(ar);
     let isEnabled = A2.getStreamingModeEnabled(ar);
     let [state, setState] = useState(isEnabled);
     useEffect(() => { setState(A2.getStreamingModeEnabled(ar)) }, [ar]);
     pn(key => {
       if (key.ctrl && key.name === 's' && !key.shift && !key.meta && isSupported && !showSuggestions) {
         A2.toggleForceNonStream(ar);
         setState(A2.getStreamingModeEnabled(ar));
       }
     }, { isActive: true });
     return { isEnabled: isSupported && state, isSupported };
   })()
   ```
   并传递给 StatusBar：`streamingModeState:sMs`

### 为什么这个方案有效

在 `generateContentInternal` 中，`A2.configureThinkingRequest` 或 `A2.configureNonThinkingRequest` 在 `s&&(p.stream=!0)` 之后被调用：

```javascript
s && (p.stream = true, p.stream_options = { include_usage: true });
// ... 其他配置 ...
g?.thinking && g.thinking.maxTokens > 0
  ? A2.configureThinkingRequest(p.model, p, g.thinking)
  : A2.configureNonThinkingRequest(p.model, p);
```

因此，在 patched 方法中删除 `stream` 字段，相当于在源码设置 `stream=true` 之后再覆盖它，确保非流式模式生效。

## 兼容性

- **thinking-mode-refactor**：兼容。两者都修改 A2，但作用不同（thinking 修改 `registerModel`，streaming 修改 `configure*Request`）
- **multimodal-image-refactor**：兼容。加载目标不同（`_4` vs `A2`）
- 三者同时安装时的 code.js 格式：

```javascript
},A2=new Dqe,require('./thinking-model-loader.cjs').load(A2),require('./streaming-model-loader.cjs').load(A2),require('./multimodal-model-loader.cjs').load(_4)});function Pln(){
```

## 安装

### 通过 iFlow Mod 管理器

导入 `dist/com.streaming-mode-refactor.mod-v1.0.0.iflow-mod` 安装包。

### 手动安装

1. 将 `streaming-model-loader.cjs` 复制到 iFlow 的 `iflow.js` 所在目录
2. 将 `streaming-models.json` 复制到 `~/.iflow/` 目录
3. 在 `iflow.js` 中找到 `},A2=new Dqe});`，替换为：

```javascript
},A2=new Dqe,require('./streaming-model-loader.cjs').load(A2)});
```

4. 重启 iFlow