<h1 align="center">

Terminator

   <img src="build/appicon.png" width=250 alt="Terminator logo"/>

</h1>

<h3 align="center">

可自建的 SSH 客户端 · 支持端到端加密同步

</h3>

Terminator 是一款基于 [Wails v3](https://v3.wails.io/) 和 Go 构建的跨平台 SSH 客户端，支持自建服务器进行端到端加密同步。

## 功能特性

- **端到端加密。** 所有敏感数据在本地使用 Argon2id 和 AES-256-GCM 加密，数据在离开客户端之前就已加密。
- **多设备同步。** 支持在多台设备间同步加密数据，服务器永远无法解密你的内容。
- **深色/浅色主题。** 内置精致深色（Abyss）与浅色（Frost）双主题，可在设置中随时切换。
- **轻量高效。** 二进制约 15MB，内存占用约 10MB。
- **本地优先。** 你*不必*使用服务器，纯本地使用完全没问题。
- 跨平台支持：
  - [Windows](https://github.com/YCJE/Terminator/releases/latest/download/terminator-amd64-installer.exe)
  - [Linux](https://github.com/terminator-ssh/terminator-desktop/releases/latest/download/Terminator-linux-stable.AppImage)
  - [macOS](https://github.com/terminator-ssh/terminator-desktop/releases/latest/download/Terminator-macos-stable-Setup.pkg)

## 云端服务器

Terminator 采用本地优先设计，同时支持端到端加密同步。服务器端代码在 [这里](https://github.com/terminator-ssh/terminator-server)。

连接云端服务器后，可随时在设置中断开连接，断开后本地数据保持不变。

## 开发路线

- [x] 端到端加密
- [x] 多设备同步
- [x] SSH 密钥管理
- [x] 深色/浅色主题切换
- [x] 首次启动默认中文
- [ ] 主机分组
- [ ] 交互式密码输入
- [ ] 多配置文件（团队？）
- [ ] 快捷键
- [ ] Android 客户端
- [ ] CLI 客户端
- [ ] SFTP 文件传输

缺少什么功能？欢迎提 [Issue](https://github.com/YCJE/Terminator/issues/new) 建议！

## 截图

<img src="assets/term-en-white.png" width="1600" alt="Terminator 主界面"/>
<img src="assets/term-t-white.png" width="1600" alt="Terminator 终端"/>

## 开发

### 环境要求

1. [**Go**](https://go.dev/dl/) (1.25+)
2. [**Node.js**](https://nodejs.org/en/download/current) (v24+)
3. *推荐* [**pnpm**](https://pnpm.io/installation#using-corepack)
4. [**Wails3 CLI**](https://v3.wails.io/getting-started/installation/)

### 构建

开发模式：
```
wails3 dev
```

远程调试（使用 [delve](https://github.com/go-delve/delve/tree/master/Documentation/installation)）：
```sh
dlv debug --headless --listen=:2345 ./backend/cmd/terminator-desktop -- dev
```

打包发布：
```
wails3 task package
```

### 致谢

灵感来源：[Termius](https://termius.com)

技术框架：[Wails](https://v3.wails.io)

UI 组件：[shadcn](https://ui.shadcn.com)

---

[English](./README_EN.md)
