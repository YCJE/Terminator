package main

import (
	"strings"

	"terminator-desktop/backend/internal/services/backup"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// cancelledByUser 是 wails 文件对话框在用户取消时返回的错误文本。
// wails 内部错误类型不可导入，只能按文本识别；这同时与全局日志过滤器
// 抑制 "cancelled by user" 的处理保持一致。
const cancelledByUser = "cancelled by user"

// wailsFileDialog 用原生文件对话框实现 backup.FileDialog。
type wailsFileDialog struct {
	app *application.App
}

func newWailsFileDialog(app *application.App) *wailsFileDialog {
	return &wailsFileDialog{app: app}
}

// ChooseSavePath 弹出保存对话框；用户取消时返回空路径且不报错。
func (d *wailsFileDialog) ChooseSavePath(defaultName string) (string, error) {
	path, err := d.app.Dialog.SaveFileWithOptions(&application.SaveFileDialogOptions{
		Title:    "导出备份",
		Filename: defaultName,
		Filters: []application.FileFilter{
			{DisplayName: "Terminator 备份 (*.json)", Pattern: "*.json"},
		},
	}).PromptForSingleSelection()
	if isCancelled(err) {
		return "", nil
	}
	return path, err
}

// ChooseOpenPath 弹出打开对话框；用户取消时返回空路径且不报错。
func (d *wailsFileDialog) ChooseOpenPath() (string, error) {
	path, err := d.app.Dialog.OpenFileWithOptions(&application.OpenFileDialogOptions{
		Title:                "选择备份文件",
		CanChooseFiles:       true,
		AllowsOtherFileTypes: true,
		Filters: []application.FileFilter{
			{DisplayName: "Terminator 备份 (*.json)", Pattern: "*.json"},
		},
	}).PromptForSingleSelection()
	if isCancelled(err) {
		return "", nil
	}
	return path, err
}

func isCancelled(err error) bool {
	return err != nil && strings.Contains(err.Error(), cancelledByUser)
}

var _ backup.FileDialog = (*wailsFileDialog)(nil)
