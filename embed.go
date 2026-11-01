package backend

import "embed"

//go:embed all:frontend/dist
var Frontend embed.FS

// AppIcon 应用图标（PNG），用于系统托盘等需要在运行时传给系统的场景。
//
//go:embed build/appicon.png
var AppIcon []byte
