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
- 多标签页管理，每个标签独立 SSH 会话，支持拖拽排序
- Trust-On-First-Use (TOFU) 主机密钥验证，防止中间人攻击
- 终端主题跟随应用主题（深色 Abyss / 浅色 Frost）实时切换
- 终端配色与 UI 强调色联动：切换强调色后终端 ANSI 蓝色/青色/光标色同步变化
- 完整 ANSI 16 色调色板 + 256 色扩展，正确显示 `ls`/`vim`/`htop` 彩色输出
- 流控背压机制（Promise 链 + writeQueue），大输出（如 `cat` 大文件）不丢数据、不卡顿
- 滚动锚定：大输出期间用户向上滚动时自动锁定位置，不被新数据冲走
- 终端失焦自动变暗，聚焦时恢复，多面板场景一眼分辨活动终端
- 标签页状态指示灯（绿色已连接 / 黄色连接中 / 红色已断开）
- 标签页崩溃后自动恢复（SerializeAddon 会话序列化）
- **终端搜索**：Ctrl+F 呼出搜索面板，支持上一个/下一个跳转，Esc 关闭
- **关键词高亮**：实时高亮终端输出中的 ERROR/WARN/INFO/SUCCESS 等关键词，可在设置中开关
- **多终端广播**：开启广播模式后，在一个终端输入的命令会同步发送到所有已连接终端，适合批量运维

### SSH 连接管理

- SSH 连接复用（Multiplexer）：同一主机多会话共享底层 TCP 连接，减少握手开销
- Jump Host 跳板机支持：通过中间主机跳转连接目标机器
- 端口转发：支持本地转发（Local Forward）和远程转发（Remote Forward），可视化 UI 管理
- 连接池健康检查，自动剔除死连接，refCount 引用计数防止误关 in-use 连接
- **SSH Agent 转发**：支持 per-host 配置 Agent Forwarding，允许远程服务器通过本地 SSH Agent 认证
- **HTTP/SOCKS5 代理**：支持 per-host 配置 HTTP CONNECT 或 SOCKS5 代理连接 SSH，可设置代理认证

### 主机与密钥管理

- Netcatty 风格侧滑面板：新增/编辑主机和密钥时从右侧滑出面板，支持拖拽调整宽度
- 主机分组：按分组管理主机，支持折叠/展开，搜索可匹配分组名
- 操作系统图标：主机列表根据 OS 类型显示不同图标（Linux/Windows/macOS）
- 交互式密码输入：可选择不保存密码，每次连接时弹出密码输入框
- SSH 密钥管理：密钥加密存储，支持密钥认证连接
- 内置密钥生成：支持 Ed25519 和 RSA 密钥对生成，可从文件导入
- **导入/导出主机配置**：支持 JSON 格式批量导出和导入主机列表（不含密码等敏感字段）
- **标签页自定义颜色**：右键标签页选择 8 种预设颜色，左侧色条指示，可在设置中开关

### 可视化文件管理

- FinalShell 风格侧边面板，终端右侧可折叠展开
- 双面板布局：左侧目录树导航 + 右侧文件列表，可拖拽调整宽度
- 虚拟列表渲染，万级文件目录流畅滚动
- 复用 SSH 连接的 SFTP 子通道，无需额外认证
- 面包屑导航 + 文件列表（名称/大小/权限/修改时间）
- 上传/下载（拖拽 + 按钮选择），32KB 分块传输 + 实时进度条
- 文件操作：新建文件夹、删除、重命名、修改权限、文本预览（<1MB）
- **文件搜索**：支持当前目录即时过滤和全系统递归搜索两种模式，一键切换
- **滚动位置记忆**：进入子目录后返回上级时，自动恢复到之前的浏览位置
- **远程文件直接编辑**：预览对话框支持编辑模式，保存后直接写回远程服务器

### 代码片段

- 侧边面板管理常用命令片段，支持搜索和分组
- 点击片段直接在当前终端执行，广播模式下同步到所有终端
- 每个片段标签 hover 显示编辑/删除按钮，也支持右键菜单
- 新增/编辑弹窗支持分组自动补全，复用已有分组名

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
- **GitHub 更新检查**：设置页一键检查 GitHub Releases 新版本
- **自动更新**：内置版本检查和更新器
- **强调色预设**：7 种强调色（默认/天蓝/翡翠/紫罗兰/琥珀/玫瑰/青色），深浅模式独立配色
- **界面密度调节**：紧凑/标准/宽松三档密度，标题栏/侧边栏/间距全面调整
- **终端配色联动**：可开关，开启后终端 ANSI 配色跟随 UI 强调色变化
- **功能开关统一管理**：关键词高亮、多终端广播、标签页颜色等功能均可在设置页终端区开关
- **会话日志记录**：SSH 输出实时写入日志文件，设置页可查看
- **多语言**：中文/英文，首次启动默认中文
- **深色/浅色主题**：Abyss 深色 / Frost 浅色，随时切换
- **RAF 批量合并**：高频事件通过 requestAnimationFrame 合并，减少不必要的重渲染
- **错误降级**：错误分类 + 防抖窗口，避免短时间大量错误弹窗淹没用户
- **ConfigProxy 默认值擦除**：配置文件只保存用户实际修改项，保持精简

## 云端服务器

自建服务器同步方案的服务端代码在 [terminator-server](https://github.com/YCJE/Terminator)，Docker 一行部署：

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
- [x] 主机分组
- [x] 交互式密码输入
- [x] SSH 连接复用 + Jump Host 跳板机
- [x] 端口转发（本地/远程）+ 可视化管理界面
- [x] 终端流控背压 + 滚动锚定 + 虚拟列表
- [x] 强调色预设 + 终端配色联动
- [x] 界面密度调节（紧凑/标准/宽松）
- [x] 侧滑面板 UI（Netcatty 风格，可拖拽调整宽度）
- [x] 标签页恢复（SerializeAddon）
- [x] RAF 批量合并 + 错误去抖
- [x] ConfigProxy 默认值擦除
- [x] 文件搜索（当前目录过滤 + 全系统递归搜索）
- [x] 滚动位置记忆（目录导航后恢复浏览位置）
- [x] 代码片段管理（分组、搜索、一键执行、编辑删除）
- [x] 多终端广播模式（批量运维）
- [x] 终端关键词高亮（ERROR/WARN/INFO/SUCCESS）
- [x] SSH Agent 转发（per-host 配置）
- [x] HTTP/SOCKS5 代理（per-host 配置）
- [x] 标签页自定义颜色（8 色预设）
- [x] 主机配置导入/导出（JSON 格式）
- [x] 远程文件直接编辑（预览 → 编辑 → 保存）
- [x] 终端搜索（Ctrl+F）
- [x] 会话日志记录 + 设置页查看
- [x] 功能开关统一管理（设置页终端区）
- [ ] 多配置文件（团队）
- [ ] 快捷键
- [ ] Android 客户端
- [ ] CLI 客户端

缺少什么功能？欢迎提 [Issue](https://github.com/YCJE/Terminator/issues/new)。

## 致谢

本项目基于 [Terminator](https://github.com/terminator-ssh/terminator-desktop) 开源项目，在其基础上进行了功能扩展和改进。

灵感来源：[Termius](https://termius.com)、[Netcatty](https://netcatty.com)、[Tabby](https://tabby.sh)、[Warp](https://www.warp.dev)

技术框架：[Wails](https://v3.wails.io)

UI 组件：[shadcn](https://ui.shadcn.com)

---

[English](./README_EN.md)
