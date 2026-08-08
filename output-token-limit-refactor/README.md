# Output Token Limit Refactor

解决对话过程中出现的 `⚠️ 因 token 限制而截断响应。` 问题。通过外部 JSON 配置按模型自定义输出 token 上限（`max_new_tokens` / `max_tokens`），无需修改源码即可防止响应被服务端提前截断。

## 问题根源

iFlow 在源码 `MOt()` 函数（L880）中硬编码了各模型的输出 token 上限表：

| 模型 | 硬编码上限 |
|------|-----------|
| 未知模型（兜底） | **8000** |
| qwen3 默认 | **8192** |
| qwen / deepseek-v3 | 8192 |
| gpt 默认 | 16384 |
| kimi / glm 默认 | 32768 |
| claude / gemini-2.5 | 65536 |

请求发送前（L956），iFlow 计算上限 `A = MOt(model, ..., config.getOutputTokensLimit())` 并无条件写入 `p.max_new_tokens = A`（kimi-k2.5 / deepseek 还会写 `p.max_tokens`）。当模型输出超过该值，API 以 `finish_reason=max_tokens` 截断，iFlow 仅显示警告后停止。

虽然 `settings.json` 的 `outputTokensLimit` 可全局覆盖，但它不区分模型、且多数用户不知道该选项。本 MOD 提供按模型正则匹配的外置配置。

## 架构

```
A2.configureThinkingRequest / configureNonThinkingRequest（monkey-patch）
  └─ applyOutputTokenLimit(config, modelName, requestBody)
       ├─ resolveLimit()      → modelLimits 正则匹配 > defaultLimit > 0（不劫持）
       └─ hijackField()       → Object.defineProperty 拦截 max_new_tokens / max_tokens
```

**为什么用 defineProperty**：`p.max_new_tokens = A` 的赋值发生在 `configure*Request` **之后**，patch 中直接改字段会被覆盖。因此安装 getter/setter 吞掉后续赋值，使 `JSON.stringify(p)` 时返回配置值。

### 两种模式

| 模式 | 行为 |
|------|------|
| `floor`（默认） | 生效值 = max(配置值, iFlow 内置值)，**只调高不调低**（如 gemini 内置 65536 保持不变） |
| `override` | 生效值 = 配置值，强制覆盖 |

## 文件说明

| 文件 | 说明 |
|------|------|
| `code.js` | 修改后的 iFlow 源码包。在 `A2 = new Dqe()` 后插入 `,require('./output-token-limit-loader.cjs').load(A2)`（iFlow 原始文件已自带 ESM wrapper，无需额外添加）。 |
| `output-token-limit-loader.cjs` | 配置加载器。读取 `~/.iflow/output-token-limits.json`，monkey-patch 两个 configure 方法。 |
| `output-token-limits.json` | 外部配置文件模板。 |
| `mod.json` | Mod 元数据，定义名称、版本、依赖、安装文件映射。 |

## 安装

### 方式一：通过 iFlow Mod 管理器

1. 构建 Mod 包
2. 在 iFlow 的 Mod 管理器中导入安装
3. 重启 iFlow

### 方式二：手动安装

1. 将 `output-token-limit-loader.cjs` 复制到 iFlow 的 `iflow.js` 所在目录
2. 将 `output-token-limits.json` 复制到 `~/.iflow/` 目录
3. 在 `iflow.js` 中找到 `},A2=new Dqe});`，将其改为 `},A2=new Dqe,require('./output-token-limit-loader.cjs').load(A2)});`
4. 重启 iFlow

## 配置说明

编辑 `~/.iflow/output-token-limits.json` 文件。

### 默认配置

```json
{
  "version": "1.0.0",
  "mode": "floor",
  "defaultLimit": 32768,
  "modelLimits": [
    { "pattern": "^qwen3", "limit": 65536 },
    { "pattern": "^qwen2\\.5", "limit": 32768 },
    { "pattern": "^deepseek", "limit": 64000 },
    { "pattern": "^kimi", "limit": 32768 },
    { "pattern": "^glm-", "limit": 32768 }
  ]
}
```

### 配置格式

```typescript
interface OutputTokenLimitsConfig {
  mode?: 'floor' | 'override';  // 默认 "floor"
  defaultLimit?: number;        // 全局兜底上限；0 或缺省 = 不劫持
  modelLimits?: Array<{         // 按模型正则匹配，首个命中生效
    pattern: string;            // 正则（忽略大小写），非法时回退子串匹配
    limit: number;              // 输出 token 上限
  }>;
}
```

### 匹配优先级

1. `modelLimits` 中首个 pattern 匹配的规则 → 使用其 `limit`
2. `defaultLimit`（全局兜底）
3. 均为 0 / 缺失 → 不劫持请求，iFlow 内置 `MOt()` 行为原样保留

### 注意事项

- 配置值最终是否生效取决于**服务端模型自身的最大输出能力**：请求 64K 而模型硬上限 8K 时，响应仍会在 8K 处截断。请根据所用模型的实际上限配置。
- `floor` 模式是最安全的选择：永远不会把 iFlow 内置表给出的更高值调低。
- 与 `settings.json` 的 `outputTokensLimit` 关系：本 MOD 配置优先；MOD 未匹配/未启用时，settings 与内置表按原逻辑生效。

## 运行时 API

加载器在 `A2` 上附加以下方法：

| 方法 | 说明 |
|------|------|
| `resolveOutputTokenLimit(modelName)` | 查询某模型当前生效的配置上限（0 = 不劫持） |
| `getOutputTokenLimitConfig()` | 获取当前生效的配置 |
| `updateOutputTokenLimitConfig(newConfig)` | 更新配置并持久化回 `~/.iflow/output-token-limits.json` |
| `reloadOutputTokenLimitConfig()` | 从磁盘重新加载配置 |

## 兼容性

- **iFlow 版本**: 0.5.19
- **类型**: `patch`（1 行插入）
- **加载目标**: `A2`（Dqe 实例），monkey-patch `configureThinkingRequest` / `configureNonThinkingRequest`
- **与其他 MOD 共存**: 与 thinking-mode-refactor、streaming-mode-refactor、kimi-request-override-refactor 共用同一插入点，各自独立包装同一对方法，互不冲突

多 MOD 插入点示例：

```javascript
},A2=new Dqe,require('./thinking-model-loader.cjs').load(A2),require('./output-token-limit-loader.cjs').load(A2),require('./multimodal-model-loader.cjs').load(_4)});
```

## 边界防护

| 异常场景 | 处理方式 |
|----------|----------|
| 配置文件不存在 | 使用内置默认配置（floor / 32768） |
| JSON 语法错误 | console.warn + 回退默认配置 |
| adapter 无效 | console.warn + 跳过 |
| 正则非法 | console.warn + 子串包含匹配 |
| limit 非正数 | 视为 0，该规则被过滤 / 不劫持 |
| mode 非法 | console.warn + 回退 "floor" |

## License

MIT
