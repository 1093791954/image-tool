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
- 生成和提示词优化由当前浏览器直接请求上游接口；中转站登录取 Key 通过同源代理避免跨域 Cookie 限制
- 支持 URL 和 `b64_json` 两种图片返回格式

## 内置提示词工程

本项目内置可复用的图像提示词优化模板，用于快速生成、高级生成、工作流节点
和电商主题等场景。提示词优化会调用用户在控制台配置的文本模型，不需要额外
部署 Prompt Optimizer 服务。

部分提示词工程思路和模板结构参考并改写自
[`linshenkx/prompt-optimizer`](https://github.com/linshenkx/prompt-optimizer)，
该项目采用 GNU AGPLv3 许可证。本项目保留来源说明并继续以
`AGPL-3.0-or-later` 开源，详见 [NOTICE](./NOTICE)。

## 开发运行

```bash
npm install
```

终端 1：

```bash
npm run backend
```

终端 2：

```bash
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

## 生产部署

线上需要部署前端静态文件和同源登录代理。推荐让后端服务同时托管 `dist`：

```bash
npm run build
IMAGE_TOOLS_STATIC_DIR=dist HOST=127.0.0.1 PORT=19080 python server/server.py
```

然后用 Nginx、Caddy 或宝塔把公网域名反向代理到 `127.0.0.1:19080`。用户访问同一个域名时：

- `/`、`/assets/*` 等路径返回前端静态文件。
- `/api/newapi/login-key` 由后端代理登录中转站并返回两个 API Key。
- 生图、获取模型和提示词优化请求使用拿到的 API Key，从用户浏览器直接请求配置的 Base URL。

可用 `/api/health` 检查后端是否可达。

## 本地数据说明

- 图片、提示词、模型、生成参数保存在浏览器 IndexedDB。
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

## 中转站登录代理

“登录中转站”会通过同源 `POST /api/newapi/login-key` 代理登录 New API 站点，并自动查找或创建 `gpt 2` 分组秘钥：

- `gpt-image-2`：用于生图。
- `gpt-5.5`：用于提示词优化。

`gpt 2` 分组的 `gpt-image-2` 使用 OpenAI 兼容图片接口的默认 URL 响应；为兼容当前号池，工具不会向该模型发送 `response_format`。

本地开发时，Vite 会把 `/api` 代理到 `http://127.0.0.1:19080`。线上部署时，需要在前端同源域名下提供兼容的 `/api/newapi/login-key` 代理接口。

## 开源协议

本项目采用 GNU Affero General Public License v3.0 or later
（`AGPL-3.0-or-later`）开源，完整协议见 [LICENSE](./LICENSE)。

如果你修改本项目并发布修改版，或将修改版作为网络服务提供给用户使用，
你需要按照 AGPLv3 的要求向这些用户提供对应的完整源代码，并让衍生作品继续
在兼容的 AGPL 条款下开放。

本项目包含参考并改写自 `linshenkx/prompt-optimizer` 的提示词模板内容，相关
来源和许可证说明见 [NOTICE](./NOTICE)。
