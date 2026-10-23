# Terminator v0.8.2

本次更新修复了 v0.8.1 遗漏的两处界面问题，属于补丁版本，建议所有 v0.8.1 用户升级。

## 界面修复

- **应用内图标同步**：左上角标题栏、锁屏页与浏览器 favicon 使用的 PNG 资源此前仍是旧图标，现已替换为与安装包一致的终端提示符 `>_` 图标。
- **标签栏重复底边**：标签栏与标题栏各自绘制了 1px 底边，两层贴在一起形成深浅不一的双线。现已取消标签栏的边框，由标题栏统一绘制单条发丝线；当前标签页的高亮指示线保持不变。

> v0.8.1 的安装包不包含以上两项修复，如需干净的界面显示请使用本版本。

## 资源

| 文件 | 说明 |
|---|---|
| `terminator-amd64-installer.exe` | Windows 安装包（推荐），自动安装 WebView2 |
| `terminator.exe` | 免安装版，直接运行 |

## 技术栈

Go 1.25 + Wails v3 + React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui + Zustand + xterm.js 6 + SQLite
