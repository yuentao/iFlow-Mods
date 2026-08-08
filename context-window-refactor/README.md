# Context Window Refactor

修复状态栏 `上下文剩余 xx%` 在某些情况下显示 **0%** 或计算不准确的问题。让状态栏显示与压缩逻辑一样读取 iFlow 自带 `settings.json` 中的 **`tokensLimit`** 字段，两者保持一致。

## 问题根源

状态栏显示逻辑（L6217）：

```javascript
k = t ? JR(t) : 0;            // 上下文窗口，仅由硬编码表决定
R = k > 0 ? c / k : 0;        // c = 最近一次请求的 prompt token 数
percentage = max(0, (1-R)*100) // c ≥ k 时钳位到 0%
```

`JR(model, settingsLimit)` 的设计是：第二参数（即 settings.json 的 `tokensLimit`）大于 0 时优先返回。但**只有压缩相关的 3 处调用（L3358/L3436/L6475）传了它，状态栏显示的调用（L6217）没有传**——因此：

- 显示永远使用硬编码窗口表，未知模型一律兜底 **128000**
- 实际窗口更大的模型：用量超过 128K 后 API 仍正常，状态栏却显示 `上下文剩余 0%`
- 实际窗口更小的模型：显示过于乐观的剩余比例
- 用户在 settings.json 配置的 `tokensLimit` 对显示**完全无效**，显示与压缩行为不一致

## 修复方案

精准替换 `JR()` 函数体（仅插入 1 句），在 `if(e&&e>0)return e;` 之后补上对 settings.json `tokensLimit` 的读取：

```
patched JR(model, settingsLimit)
  ├─ 1. 调用方显式传入的 settingsLimit > 0 → 该值（原逻辑，压缩路径）
  ├─ 2. settings.json tokensLimit > 0 → 该值（新增，补齐显示路径）
  ├─ 3. 内置硬编码表（kln / uis）           （原逻辑）
  └─ 4. 内置兜底 128000                     （原逻辑）
```

效果：状态栏显示与压缩阈值读取**同一个 settings.json 的同一个字段**，数值永远一致。

**零副作用设计**：settings.json 缺失、不可读或未配置正数 `tokensLimit` 时，`JR` 行为与原始代码完全一致。

## 文件说明

| 文件 | 说明 |
|------|------|
| `code.js` | 修改后的 iFlow 源码包。仅在 `JR()` 函数开头插入 1 句 settings 读取。 |
| `context-window-loader.cjs` | settings.json 读取器（TTL + mtime 缓存，编辑配置后数秒内生效）。 |
| `mod.json` | Mod 元数据，定义名称、版本、依赖、安装文件映射。 |

## 安装

### 方式一：通过 iFlow Mod 管理器

1. 构建 Mod 包
2. 在 iFlow 的 Mod 管理器中导入安装
3. 重启 iFlow

### 方式二：手动安装

1. 将 `context-window-loader.cjs` 复制到 iFlow 的 `iflow.js` 所在目录
2. 在 `iflow.js` 中找到原始 `JR` 函数：

   ```javascript
   function JR(t,e){if(e&&e>0)return e;if(!t||typeof t!="string")return Tqe;let r=t.toLowerCase();if(kln[t])return kln[t];for(let n of uis)if(n.pattern.test(r)){for(let[o,s]of Object.entries(n.limits))if(o!=="default"&&r.includes(o))return s;return n.limits.default??n.defaultLimit??Tqe}return Tqe}
   ```

   替换为：

   ```javascript
   function JR(t,e){if(e&&e>0)return e;let _s=require('./context-window-loader.cjs').readTokensLimit();if(_s>0)return _s;if(!t||typeof t!="string")return Tqe;let r=t.toLowerCase();if(kln[t])return kln[t];for(let n of uis)if(n.pattern.test(r)){for(let[o,s]of Object.entries(n.limits))if(o!=="default"&&r.includes(o))return s;return n.limits.default??n.defaultLimit??Tqe}return Tqe}
   ```

3. 重启 iFlow

## 配置说明

无需任何 MOD 自有配置文件。直接在 iFlow 的 `~/.iflow/settings.json` 中设置 `tokensLimit` 为你所用模型的实际上下文窗口：

```json
{
  "tokensLimit": 262144
}
```

- 该值将同时决定状态栏剩余百分比的计算基准与自动压缩的触发阈值
- 修改 settings.json 后数秒内自动生效（mtime 检测），无需重启
- 未配置或配置为非正数时，回退到 iFlow 内置模型窗口表

## 运行时 API

加载器模块（`require('./context-window-loader.cjs')`）导出：

| 方法 | 说明 |
|------|------|
| `readTokensLimit()` | 读取 settings.json 的 tokensLimit（带 5 秒 TTL + mtime 缓存），未配置时返回 0 |

## 兼容性

- **iFlow 版本**: 0.5.19
- **类型**: `patch`（JR 函数体 1 句插入，不经过 L950 插入点）
- **与其他 MOD 共存**: 不与任何 L950 插入型 MOD 冲突；与 output-token-limit-refactor 正交互补（前者管输入上下文窗口，后者管输出 token 上限）
- **性能**: 5 秒 TTL + mtime 缓存，状态栏高频渲染不会反复读盘

## 边界防护

| 异常场景 | 处理方式 |
|----------|----------|
| settings.json 不存在 | 返回 0，JR 走原始内置表逻辑 |
| JSON 语法错误 | 返回 0，JR 走原始内置表逻辑 |
| tokensLimit 缺失/非正数 | 返回 0，JR 走原始内置表逻辑 |
| 设置了 IFLOW_HOME | 按 iFlow 自身规则解析 settings 路径 |

## License

MIT