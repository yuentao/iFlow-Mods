# API Profile 切换命令

## 功能概述

在 iFlow CLI 中添加 `/api` 命令，允许用户在 TUI 中切换不同的 API Profile。

## 使用方法

```bash
/api
```

执行后将显示已保存的 API Profile 列表，用户可以通过方向键选择并按回车确认切换。

## 配置说明

### settings.json 结构

```json
{
  "selectedAuthType": "openai-compatible",
  "baseUrl": "https://maas-coding-api.cn-huabei-1.xf-yun.com/v2",
  "apiKey": "9ec48e443e1821f8413230ae61a4be6b:xxx",
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
      "apiKey": "9ec48e443e1821f8413230ae61a4be6b:xxx",
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

### Profile 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| selectedAuthType | 是 | 认证类型（固定为 `openai-compatible`）|
| baseUrl | 是 | API 端点 |
| apiKey | 是 | API 密钥 |
| modelName | 是 | 模型名称 |
| tokensLimit | 否 | Token 限制 |
| expiryDays | 否 | 有效期天数 |
| expiryStartDate | 否 | 有效期开始日期 |
| _lastModified | 否 | 最后修改时间 |

### 关键字段

| 字段 | 说明 |
|------|------|
| `currentApiProfile` | 当前激活的 Profile 名称 |
| `apiProfiles` | Profile 集合（对象形式，键为 Profile 名称）|
| `apiProfilesOrder` | Profile 显示顺序（可选）|

> 注：切换 Profile 时更新 `currentApiProfile`、`baseUrl`、`apiKey`、`modelName` 四个字段。

## Profile 管理

**注意**：本 MOD 仅支持 Profile **选择** 功能。Profile 的管理（新增/编辑/删除）由外部工具 iFlow-Settings-Editor-GUI 负责。

用户需要先通过 iFlow-Settings-Editor-GUI 配置好 API Profile，然后使用 `/api` 命令进行切换。

## 实现原理

1. 在 iFlow CLI 命令注册系统中添加 `/api` 命令
2. 创建 API Profile 选择对话框组件（参考 model-command-refactor）
3. 从 `~/.iflow/settings.json` 读取 apiProfiles 对象和 currentApiProfile
4. 用户选择后更新 currentApiProfile、baseUrl、apiKey、modelName 字段

## 依赖

- iFlow CLI v0.5.19
- Node.js 内置模块：fs, path

## 安装

将 `code.js` 复制到 iFlow CLI 目录覆盖原文件。

## 卸载

恢复原始 `iflow.js.original` 文件即可。