# GPT Image Tools

一个 Web 端本地优先生图工具。用户填写 OpenAI 兼容 API 的 `Base URL` 和
`API Key`，应用会直接从浏览器调用 `/v1/models`、`/v1/images/generations`
和 `/v1/images/edits`。

## 特性

- Vite + React + TypeScript
- 可作为普通 Web App 使用，也支持浏览器安装为 PWA
- 设置和图库保存在当前浏览器 IndexedDB
- API Key 默认不保存；只有勾选后才写入当前浏览器本地存储
- 支持导出 / 导入 JSON 备份，备份不会包含 API Key
- 服务端不保存生成结果；图片生成请求会发送到用户配置的上游 API
- 支持 URL 和 `b64_json` 两种图片返回格式

## 开发运行

```bash
npm install
npm run dev
```

## 构建

```bash
npm run build
```

## 预览生产构建

```bash
npm run preview
```

## 本地数据说明

- 图片、提示词、模型、生成参数保存在浏览器 IndexedDB。
- 清理浏览器站点数据会删除本地图库。
- 建议用户定期使用“导出备份”保存 JSON 备份文件。
- 导入备份会恢复设置和图库，但不会恢复 API Key。

## 默认参数

- Base URL: `https://cc.api-corp.top`
- 推荐模型: `gpt-image-2`
- 默认价格不会在工具内计费，实际扣费由 API 站点处理。
