# GPT Image Tools

一个 Web 端本地优先生图工具。用户填写 OpenAI 兼容 API 的 `Base URL` 和
`API Key`，应用会直接从浏览器调用 `/v1/models`、`/v1/images/generations`
和 `/v1/images/edits`。

## 在线测试

已部署测试地址：<https://image.hotapi.top/>

用户可以直接打开该地址测试和体验工具。

## 特性

- Vite + React + TypeScript
- 可作为普通 Web App 使用，也支持浏览器安装为 PWA
- 设置和图库保存在当前浏览器 IndexedDB
- API Key 默认不保存；只有勾选后才写入当前浏览器本地存储
- 支持导出 / 导入 JSON 备份，备份不会包含 API Key
- 服务端会先接收生成任务并后台处理，结果会短暂写入服务器缓存，再同步到浏览器图库
- 支持 URL 和 `b64_json` 两种图片返回格式

## Prompt Optimizer 集成边界

本项目可以在控制台配置外部 Prompt Optimizer 服务地址，用于提示词优化。
Prompt Optimizer 作为独立部署的外部服务通过网络接口连接，本仓库不把
`linshenkx/prompt-optimizer` 作为子模块、依赖源码或内置组件分发。

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

- 图片、提示词、模型、生成参数保存在浏览器 IndexedDB。未完成的生成任务会在浏览器重新打开后继续轮询服务器缓存结果。
- 清理浏览器站点数据会删除本地图库。
- 建议用户定期使用“导出备份”保存 JSON 备份文件。
- 导入备份会恢复设置和图库，但不会恢复 API Key。

## 风格库

- 风格素材不放入 Git 仓库，默认从仓库外读取。
- Windows 默认路径：`D:\tmp\image-tool-lib\风格`
- Linux 默认路径：`/opt/image-tool-lib/风格`
- 可用 `IMAGE_TOOLS_STYLE_LIBRARY_DIR` 覆盖路径。
- 每个分类目录里的 `*Json.xlsx` 提供风格协议，`*-风格.jpg/png` 用作节点预览示例图。

## 默认参数

- Base URL: `https://hotapi.top`
- 推荐模型: `gpt-image-2`
- 默认价格不会在工具内计费，实际扣费由 API 站点处理。

## 开源协议

本项目采用 GNU Affero General Public License v3.0 or later
（`AGPL-3.0-or-later`）开源，完整协议见 [LICENSE](./LICENSE)。

如果你修改本项目并发布修改版，或将修改版作为网络服务提供给用户使用，
你需要按照 AGPLv3 的要求向这些用户提供对应的完整源代码，并让衍生作品继续
在兼容的 AGPL 条款下开放。

本项目允许连接用户自行部署的外部服务，例如 Prompt Optimizer；该外部服务的
源码、部署和协议义务由对应项目自身的许可证约束。
