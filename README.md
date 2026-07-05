<h1 align="center">

Terminator

<img src="build/appicon.png" width=120 alt="Terminator logo"/>

</h1>

<h3 align="center">

开源 SSH 客户端 · 端到端加密 · 可视化文件管理 · 多设备同步

</h3>

<p align="center">
  <a href="https://github.com/YCJE/Terminator/releases"><img alt="Windows" src="https://img.shields.io/badge/平台-Windows%20%7C%20Linux%20%7C%20macOS-blue"/></a>
  <img alt="Go" src="https://img.shields.io/badge/Go-1.25+-00ADD8"/>
  <img alt="React" src="https://img.shields.io/badge/React-19-61DAFB"/>
  <img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-green"/>
</p>

---

## 概述

Terminator 是一款跨平台 SSH 客户端，专注于**安全、隐私和本地控制**。所有敏感数据（主机配置、SSH 密钥、凭据）在本地使用 Argon2id + AES-256-GCM 加密，即使使用云同步，服务器也永远无法解密你的数据。

## 核心功能

### 终端

- 基于 xterm.js 6 的完整终端模拟器，支持 256 色 + Unicode 11
- 多标签页管理，每个标签独立 SSH 会话
- Trust-On-First-Use (TOFU) 主机密钥验证，防止中间人攻击
- 终端主题跟随应用主题（深色 Abyss / 浅色 Frost）实时切换
- 完整 ANSI 16 色调色板 + 256 色扩展，正确显示 `ls`/`vim`/`htop` 彩色输出

### 可视化文件管理

- FinalShell 风格侧边面板，终端右侧可折叠展开
- 复用 SSH 连接的 SFTP 子通道，无需额外认证
- 面包屑导航 + 文件列表（名称/大小/权限/修改时间）
- 上传/下载（拖拽 + 按钮选择），32KB 分块传输 + 实时进度条
- 文件操作：新建文件夹、删除、重命名、修改权限、文本预览（<1MB）

### 端到端加密同步

两种同步方式，均使用端到端加密，可自由切换：

| 方式 | 说明 | 适用场景 |
|---|---|---|
| **自建服务器** | HTTP API 增量同步，3 秒轮询，支持用户注册/登录 | 需要实时多设备同步 |
| **WebDAV** | 全量打包加密文件上传，60 秒间隔，ETag 乐观锁防冲突 | 坚果云/Nextcloud/群晖 NAS |

加密架构：

```
用户主密码
    ├── Argon2id + KeySalt → KEK → 加密 MasterKey
    └── Argon2id + AuthSalt → LoginKey → 服务器认证
                                           (不传主密码)
```

### 其他

- **本地优先**：不必连接任何服务器，纯本地使用完全没问题
- **SSH 密钥管理**：密钥加密存储，支持密钥认证连接
- **自动更新**：内置版本检查和更新器
- **多语言**：中文/英文，首次启动默认中文
- **深色/浅色主题**：Abyss 深色 / Frost 浅色，随时切换

## 截图

<img src="assets/term-en-white.png" width="1600" alt="主界面"/>
<img src="assets/term-t-white.png" width="1600" alt="终端"/>

## 下载

- [Windows 安装包](https://github.com/YCJE/Terminator/releases/latest/download/terminator-amd64-installer.exe)
- [Windows 便携版](https://github.com/YCJE/Terminator/releases/latest/download/terminator.exe)
- [Linux AppImage](https://github.com/terminator-ssh/terminator-desktop/releases/latest/download/Terminator-linux-stable.AppImage)
- [macOS](https://github.com/terminator-ssh/terminator-desktop/releases/latest/download/Terminator-macos-stable-Setup.pkg)

## 云端服务器

自建服务器同步方案的服务端代码在 [terminator-server](https://github.com/terminator-ssh/terminator-server)，Docker 一行部署：

```bash
docker run --name terminator \
  -v terminator-data:/app/data \
  -p 8080:8080 -d deeplerg/terminator
```

WebDAV 同步无需自建服务器，填入网盘地址即可使用。

## 技术架构

```
terminator/
├── backend/                          # Go 后端
│   ├── cmd/terminator-desktop/       # 应用入口 + Wails 绑定
│   │   ├── main.go                   # 服务注册和依赖注入
│   │   ├── app.go                    # 前端可调用方法
│   │   └── emitters/                 # Wails 事件发射器
│   │       ├── ssh.go                #   SSH 终端数据/关闭事件
│   │       ├── sftp.go              #   SFTP 传输进度/完成事件
│   │       ├── sync.go              #   同步状态事件
│   │       └── updater.go           #   更新器事件
│   └── internal/
│       ├── services/
│       │   ├── ssh/                  # SSH 连接管理 + PTY
│       │   ├── sftp/                 # SFTP 文件管理
│       │   ├── auth/                 # 用户认证 + 保险库
│       │   ├── sync/                 # 同步引擎
│       │   │   ├── sync.go           #   服务器同步
│       │   │   ├── webdav.go         #   WebDAV 同步
│       │   │   └── loop.go           #   自动同步循环
│       │   ├── blob/                 # 加密数据存储
│       │   ├── settings/             # 应用配置
│       │   └── updater/              # 自动更新
│       ├── crypto/                   # Argon2id + AES-256-GCM
│       ├── vault/                    # 内存密钥管理
│       ├── webdav/                   # WebDAV HTTP 客户端
│       ├── dbgen/                    # sqlc 生成的 DB 查询
│       ├── migration/                # SQLite 迁移
│       └── apperror/                 # 错误码体系
│
├── frontend/                         # React 前端
│   └── src/
│       ├── components/
│       │   ├── terminal/             # xterm.js 终端组件
│       │   ├── sftp/                 # 文件管理面板
│       │   ├── layout/               # 布局框架
│       │   ├── views/                # 页面视图
│       │   └── ui/                   # shadcn 组件
│       ├── store/                    # Zustand 状态管理
│       ├── lib/                      # 工具函数
│       └── i18n/                     # 多语言
│
└── build/                            # 构建资源 + NSIS 安装包
```

**技术栈**：Go 1.25 + Wails v3 + React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui + Zustand + xterm.js 6 + SQLite

## 开发

### 环境要求

1. [Go](https://go.dev/dl/) 1.25+
2. [Node.js](https://nodejs.org/) v24+
3. 推荐安装 [pnpm](https://pnpm.io/installation#using-corepack)
4. [Wails3 CLI](https://v3.wails.io/getting-started/installation/)

### 开发模式

```bash
wails3 dev
```

远程调试（[delve](https://github.com/go-delve/delve)）：

```bash
dlv debug --headless --listen=:2345 ./backend/cmd/terminator-desktop -- dev
```

### 打包

```bash
wails3 task package
```

## 开发路线

- [x] 端到端加密（Argon2id + AES-256-GCM）
- [x] 多设备同步（自建服务器 + WebDAV）
- [x] SSH 密钥管理
- [x] 深色/浅色主题
- [x] SFTP 可视化文件管理
- [x] 终端 256 色支持
- [x] 多语言（中文/英文）
- [ ] 主机分组
- [ ] 交互式密码输入
- [ ] 多配置文件（团队）
- [ ] 快捷键
- [ ] Android 客户端
- [ ] CLI 客户端

缺少什么功能？欢迎提 [Issue](https://github.com/YCJE/Terminator/issues/new)。

## 致谢

本项目基于 [Terminator](https://github.com/terminator-ssh/terminator-desktop) 开源项目，在其基础上进行了功能扩展和改进。

---

[English](./README_EN.md)
