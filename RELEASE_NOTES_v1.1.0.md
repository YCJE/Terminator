# Terminator v1.1.0

v1.0 以来的重大更新：新增 SSH 连接复用、Jump Host 跳板机、端口转发、终端流控背压、SFTP 虚拟列表、6 种强调色预设、UI/UX 全面升级，以及修复 15 项漏洞和 Bug。

## 新增功能

### SSH 连接复用 + Jump Host 跳板机

- 同一主机多会话共享底层 TCP 连接，减少重复 SSH 握手开销
- Jump Host 支持：通过跳板机中转连接目标机器，适配企业内网场景
- 连接池带健康检查，自动剔除死连接
- refCount 引用计数管理，防止误关正在使用的连接

### 端口转发

- **本地转发（Local Forward）**：将远程端口映射到本地，访问远程服务如访问本地
- **远程转发（Remote Forward）**：将本地端口映射到远程，反向穿透内网
- 转发连接任意方向断开时自动关闭双端，无 goroutine 泄漏

### 终端性能优化

- **流控背压**：xterm.js 输出流量控制，大输出（`cat` 大文件、`find /`）不丢数据、不卡顿
- **滚动锚定**：大量输出时保持视口位置，不会跳动
- **标签页恢复**：SerializeAddon 序列化终端会话，崩溃后可恢复
- **RAF 批量合并**：高频事件通过 requestAnimationFrame 合并渲染，减少 CPU 占用

### SFTP 虚拟列表

- 文件列表采用虚拟滚动渲染，万级文件目录流畅滚动
- 双面板布局：左侧目录树导航 + 右侧文件列表
- 目录树可拖拽调整宽度

### UI/UX 全面升级（13 项改进）

- 6 种强调色预设：天蓝 / 翡翠 / 紫罗兰 / 琥珀 / 玫瑰 / 青色
- 深色模式和浅色模式各自独立配色，切换主题不串色
- 标签页状态指示灯（绿色已连接 / 黄色连接中 / 红色已断开）
- 终端失焦自动变暗，聚焦时恢复
- 主机列表根据 OS 类型显示不同图标（Linux/Windows/macOS）
- 设置页面结构重组，分区更清晰
- 标签页拖拽排序（Firefox 兼容）

### GitHub 更新检查

- 设置页"关于"卡片新增"检查更新"按钮
- 通过 GitHub API 检查最新 Release，版本号 semver 比较
- 一键跳转到 Release 页面下载

### 错误降级机制

- 错误分类（网络/认证/超时/未知）+ 防抖窗口
- 短时间大量同类错误合并为一条通知，不弹窗轰炸用户

## Bug 修复（15 项）

### SSH 后端

1. **连接池 releaseClient 按 key 误关新连接**：传入 `*ssh.Client` 验证身份，不再按 key 盲目操作
2. **连接池 Close 持锁阻塞**：`client.Close()` 移至锁外执行，避免网络 I/O 阻塞连接池
3. **健康检查关闭 in-use 连接**：`refCount>0` 时不关闭，由各 session 断开时自行释放
4. **端口转发 io.Copy 单向阻塞泄漏**：`sync.Once` 在任意方向结束时关闭双端连接
5. **goroutine panic 未恢复**：所有 SSH goroutine 增加 `defer recover()` + 资源清理

### WebDAV 同步

6. **错误路径未排空响应体**：GetFile/TestConnection 在 404/400+ 路径增加 `io.Copy(io.Discard)`，修复 HTTP 连接无法复用
7. **HTTP 请求无法取消**：所有 WebDAV 函数增加 `context.Context` 参数，改用 `NewRequestWithContext`

### 前端

8. **FilePanel 切换主机残留旧目录树**：init effect 中重置 `treeChildren`/`treeExpanded`
9. **FilePanel loadTreeChildren 竞态条件**：增加 `loadIdRef` 检查，会话切换时丢弃旧数据
10. **FilePanel 拖拽事件泄漏**：`startTreeResize` 增加 `treeResizeCleanupRef`，卸载时清理
11. **TerminalInstance Esc 键闭包陷阱**：用 `showSearchRef` 替代闭包变量，修复搜索面板无法用 Esc 关闭
12. **SettingsPage 终端配色不同步**：`terminalColorLink` effect 加入 `accentColor` 依赖
13. **TerminalTab 拖拽不兼容 Firefox**：`onDragStart` 增加 `dataTransfer.setData`
14. **TerminalTab onDragEnd 未重置状态**：拖拽取消后 `isDraggedOver` ref 保持 true，无法再次触发
15. **main.css 强调色优先级错误**：`:root[data-accent]` 特异性高于 `.dark`，暗色模式误用亮色值，改为 `.dark[data-accent]` 和 `:root:not(.dark)[data-accent]`

## 下载

| 文件 | 大小 | 说明 |
|---|---|---|
| `terminator-amd64-installer.exe` | ~18.7 MB | Windows 安装包（推荐），支持自选安装路径，自动安装 WebView2 |
| `terminator.exe` | ~54.2 MB | 免安装版，直接运行 |

## 技术栈

Go 1.25 + Wails v3 + React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui + Zustand + xterm.js 6 + SQLite

## 致谢

本项目基于 [Terminator](https://github.com/terminator-ssh/terminator-desktop) 开源项目。

灵感来源：[Termius](https://termius.com)、[Netcatty](https://netcatty.com)、[Tabby](https://tabby.sh)、[Warp](https://www.warp.dev)

技术框架：[Wails](https://v3.wails.io)
