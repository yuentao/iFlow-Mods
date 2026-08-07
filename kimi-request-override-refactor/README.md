# Kimi Request Override Refactor

为 Kimi 模型（OpenAI Compatible API 模式）提供请求参数兼容层。通过外部 JSON 配置，按模型名覆盖或删除请求字段，默认适配 kimi-k3 的固定采样参数、thinking 清理与 `reasoning_effort` 默认值。

## 概述

iFlow 默认的请求参数无法满足 Kimi（尤其是 kimi-k3）的固定参数要求，例如：

- 需要固定的采样参数（`temperature`、`top_p`、`presence_penalty`、`frequency_penalty`）
- 使用 `reasoning_effort` 而非遗留的 `thinking` 字段
- 遗留 `thinking` 字段会导致 API 拒绝

本 Mod 通过 monkey-patch `A2.configureThinkingRequest` 和 `A2.configureNonThinkingRequest`，在请求体生成后按模型名匹配规则，动态 `set` / `delete` / `setIfMissing` 请求字段，无需修改源码。

## 架构

```
A2.configureThinkingRequest / configureNonThinkingRequest（monkey-patch）
  └─ applyRequestOverrides(modelName, requestBody, config)
       ├─ getMatchedOverrides() → 按正则匹配规则
       ├─ applyOverrideRule()   → set / delete / setIfMissing
```

### 规则原语

| 原语 | 说明 |
|------|------|
| `set` | 强制设置字段值（覆盖已有值） |
| `delete` | 删除请求中的字段 |
| `setIfMissing` | 仅当字段不存在时设置默认值 |

## 文件说明

| 文件 | 说明 |
|------|------|
| `code.js` | 修改后的 iFlow 源码包。在 `A2 = new Dqe()` 后插入 `,require('./kimi-request-override-loader.cjs').load(A2)`。 |
| `kimi-request-override-loader.cjs` | 配置加载器。读取 `~/.iflow/kimi-request-overrides.json`，monkey-patch 两个 configure 方法。 |
| `kimi-request-overrides.json` | 外部配置文件模板。 |
| `mod.json` | Mod 元数据，定义名称、版本、依赖、安装文件映射。 |

## 安装

### 方式一：通过 iFlow Mod 管理器

1. 构建 Mod 包
2. 在 iFlow 的 Mod 管理器中导入安装
3. 重启 iFlow

### 方式二：手动安装

1. 将 `kimi-request-override-loader.cjs` 复制到 iFlow 的 `iflow.js` 所在目录
2. 将 `kimi-request-overrides.json` 复制到 `~/.iflow/` 目录
3. 在 `iflow.js` 中找到 `},A2=new Dqe});`，将其改为 `},A2=new Dqe,require('./kimi-request-override-loader.cjs').load(A2)});`
4. 重启 iFlow

## 配置说明

编辑 `~/.iflow/kimi-request-overrides.json` 文件。

### 默认配置

```json
{
  "version": "1.0.0",
  "requestOverrides": [
    {
      "pattern": "^kimi-k3(?:$|[-.:])",
      "set": {
        "temperature": 1,
        "top_p": 0.95,
        "presence_penalty": 0,
        "frequency_penalty": 0
      },
      "delete": [
        "thinking"
      ],
      "setIfMissing": {
        "reasoning_effort": "max"
      }
    }
  ]
}
```

### 配置格式

```typescript
interface OverrideRule {
  pattern: string;              // 正则模式，匹配模型名（不区分大小写）
  set?: Record<string, any>;    // 强制设置字段
  delete?: string[];            // 删除字段
  setIfMissing?: Record<string, any>; // 字段缺失时设置
}
```

### 正则匹配

- 模型名按正则 `pattern` 匹配（`i` 忽略大小写）
- 正则非法时回退为子串包含匹配（console.warn 提示）

## 运行时 API

加载器还会在 `A2` 上附加以下方法：

| 方法 | 说明 |
|------|------|
| `getKimiRequestOverrideConfig()` | 获取当前生效的配置 |
| `updateKimiRequestOverrideConfig(newConfig)` | 更新配置并持久化回 `~/.iflow/kimi-request-overrides.json` |

## 兼容性

- **iFlow 版本**: 0.5.19
- **类型**: `patch`（1 行插入）
- **加载目标**: `A2`（Dqe 实例），monkey-patch `configureThinkingRequest` / `configureNonThinkingRequest`
- **与其他 MOD 共存**: 与 thinking-mode-refactor、streaming-mode-refactor、multimodal-image-refactor 共用同一插入点，互不冲突（作用方法不同）

## 边界防护

| 异常场景 | 处理方式 |
|----------|----------|
| 配置文件不存在 | 使用内置默认规则 |
| JSON 语法错误 | console.warn + 回退默认规则 |
| adapter 无效 | console.warn + 跳过 |
| 正则非法 | console.warn + 子串包含匹配 |
| 旧版 `forceTemperatureModels` 配置 | `normalizeLegacyConfig` 自动迁移 |

## License

MIT