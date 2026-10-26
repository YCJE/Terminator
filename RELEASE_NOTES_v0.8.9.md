# Terminator v0.8.9

本次为界面修复与文档更新，程序功能与 v0.8.8 一致。

## 修复

- **端口转发地址断行**：Tailwind 预检会把 `svg` 设为 `display: block`，导致「本地 → 远程」地址中的箭头把两端拆成上下两行。新增 `.list-arrow` 显式改回 `inline-block` 并校正基线。
- **SFTP 修改时间列截断**：时间列宽度由 100px 调整为 112px，单元格改用 `truncate whitespace-nowrap` 与等宽字体，日期与时间不再被裁切。
- **日志页标题挤压**：会话日志头部在窄内容栏下被压成三行。改为可换行的两端布局，标题块设置 `min-w-[11rem]` 并允许收缩。

## 文档

- **目录**：中文 README 新增完整目录，英文 README 的 Contents 补充 12 个界面小节的锚点。
- **界面截图**：新增命令面板、命令草稿栏、端到端加密同步、安全与备份、日志与会话检索等 12 个界面小节，替换原有零散配图。
- **格式统一**：全部截图由 PNG 转为 WebP，体积下降约 62%；清除英文 README 末尾重复的 Screenshots 段。

## 已知限制

- Zmodem / trzsz 仍未接入：缺少真实 SSH 服务端验证，贸然接入可能污染终端数据流，将在后续版本以「trzsz 优先 + 可关闭开关」实现。

## 资源

| 文件 | 说明 |
|---|---|
| `terminator-amd64-installer.exe` | Windows 安装包（推荐），自动安装 WebView2 |
| `terminator.exe` | 免安装版，直接运行 |

## 技术栈

Go 1.25 + Wails v3 + React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui + Zustand + xterm.js 6 + SQLite
