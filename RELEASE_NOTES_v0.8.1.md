# Terminator v0.8.1

本次更新更换了应用图标。

## 图标更新

原图标是一副带斜纹的墨镜，存在三个问题：镜框、镜腿与镜面斜纹在 16px 任务栏尺寸下会糊成一团；白底在深色任务栏上是一块突兀的亮方块；图形本身与 SSH 终端工具没有语义关联。

新图标采用终端提示符 `>_`：

- 近黑底 squircle（圆角半径 22.6%，接近 Windows 11 / macOS 原生观感）
- 薄荷绿提示符箭头 + 浅色光标条，与 HUD 皮肤的强调色一致
- 字形外框占画布约 60%，最小描边不低于 2px（16px 尺寸下），小图标不糊
- 四角透明，浅色与深色任务栏均可用

## 资源

| 文件 | 说明 |
|---|---|
| `terminator-amd64-installer.exe` | Windows 安装包（推荐），自动安装 WebView2 |
| `terminator.exe` | 免安装版，直接运行 |

## 技术栈

Go 1.25 + Wails v3 + React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui + Zustand + xterm.js 6 + SQLite
