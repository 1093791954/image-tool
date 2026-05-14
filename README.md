# GPT Image Tools

一个本地桌面生图工具。用户填写 OpenAI 兼容 API 的 `Base URL` 和 `API Key`，工具自动读取模型列表并调用 `/v1/images/generations` 生成图片。

## 特性

- Electron + Vite + React + TypeScript
- 支持 Windows 安装包和绿色免安装目录
- API Key 默认只保存在当前窗口内，不写入磁盘
- 图片结果保存到用户本机 IndexedDB
- 服务端不保存生成结果
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

## 打包 Windows 桌面程序

绿色免安装版：

```bash
npm run pack:portable
```

输出位置：

```text
release/GPT Image Tools Portable/GPT Image Tools.exe
```

安装包：

```bash
npm run pack:win
```

输出目录：

```text
release/
```

其中 `pack:portable` 会直接组装绿色免安装目录，`pack:win` 使用
`electron-builder` 生成安装包。

如果网络无法下载 Electron 运行时，先执行：

```bash
npm run pack:portable
```

这会先产出可直接运行的绿色版桌面程序。安装包可在网络恢复后再执行
`npm run pack:win`。

## 默认参数

- Base URL: `https://cc.api-corp.top`
- 推荐模型: `gpt-image-2`
- 默认价格不会在工具内计费，实际扣费由 API 站点处理。
