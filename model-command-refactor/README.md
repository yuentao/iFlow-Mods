# iFlow CLI `/model` 命令

## 概述

`/model` 是 iFlow CLI 的 TUI 内置命令，用于交互式选择 AI 模型。用户可通过上下键从模型列表中选择，或手动输入模型名称。

## 使用方式

在 iFlow CLI 交互界面中输入 `/model` 即可打开模型选择对话框。

## 模型数据来源

### 1. API 获取（优先）

当 `~/.iflow/settings.json` 中配置了 `baseUrl` 时，优先从 API 获取模型列表：

```
GET {baseUrl}/models
Authorization: Bearer {apiKey}
```

**API 响应格式**（OpenAI 兼容）：
```json
{
  "data": [
    {
      "id": "model-name",
      "name": "Model Name",
      "context_length": 262144
    }
  ]
}
```

`apiKey` 从应用认证状态中获取。

### 2. 认证系统回退

当 API 获取失败或无 `baseUrl` 配置时，按以下优先级回退：

| 认证类型 | 数据来源 |
|---------|---------|
| iFlow / Login with iFlow | `AJ()` — 从 iFlow 认证系统获取模型列表 |
| AONE / Login with AONE | AONE API 获取 |
| 其他 | 硬编码列表（`rgt`） |

### 3. 硬编码备用列表

```javascript
[
  { label: "Qwen3-Coder",       value: "ide-whale/qwen3-coder" },
  { label: "Claude-4-Sonnet",   value: "ide-idealab/claude4-sonnet" },
  { label: "DeepSeek-V3.2-Whale", value: "ide-whale/deepseek-v3.2-exp" },
  { label: "Kimi-K2",           value: "ide-whale/kimi_k2" }
]
```

## 对话框模式

| 模式 | 触发条件 | 交互方式 |
|------|---------|---------|
| 选择模式 | 有可用模型列表 | `yl` 选择组件，上下键导航，Enter 确认 |
| 输入模式 | 无可用模型列表 | `Ty` 文本输入框，手动输入模型名称 |

## 模型保存

选择模型后，通过 `Xio.handleModelSelect` 保存：

1. `t.setValue(source, "modelName", modelName)` — 保存到应用状态
2. `r.refreshAuth(authType, { modelName, ... })` — 刷新认证信息

## 配置

在 `~/.iflow/settings.json` 中配置：

```json
{
  "baseUrl": "https://token.sensenova.cn/v1"
}
```

## 实现位置

| 组件 | 位置 | 说明 |
|------|------|------|
| `rYi` | `iflow.js.original` ~行 13203308 | 模型选择对话框组件 |
| `normalizeModelList` | ~行 12831440 | API 响应标准化 |
| `fetchModelList` | ~行 12831544 | 从 API 获取模型列表 |
| `loadModelsFromApi` | ~行 12831845 | 加载模型并回退 |
| `AJ()` | ~行 12830996 | 从 iFlow 认证获取模型 |
| `rgt` | ~行 12831211 | 硬编码备用模型列表 |
| `Xio` | ~行 13332126 | 对话框状态管理 + 模型保存 |