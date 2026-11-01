package emitters

import "github.com/wailsapp/wails/v3/pkg/application"

// EditorSavedEvent 外部编辑器自动回传结果事件。
const EditorSavedEvent = "editor:saved"

// EditorSavedPayload 自动回传结果载荷。
type EditorSavedPayload struct {
	SessionID  string `json:"sessionId"`  // 所属 SSH 会话 ID
	RemotePath string `json:"remotePath"` // 被编辑的远端路径
	Success    bool   `json:"success"`    // 是否成功回传
	Conflict   bool   `json:"conflict"`   // 远端已被他人修改，本次未回传
	Error      string `json:"error"`      // 失败原因（成功时为空）
}

// WailsEditorEmitter 通过 Wails 事件总线推送编辑器回传结果。
// 它实现了 editor.EditorEmitter 接口（结构化匹配，无需显式声明）。
type WailsEditorEmitter struct {
	app *application.App
}

// NewWailsEditorEmitter 创建基于 Wails 事件总线的编辑器 emitter。
func NewWailsEditorEmitter(app *application.App) *WailsEditorEmitter {
	return &WailsEditorEmitter{app: app}
}

// EmitEditorSaved 推送一次自动回传的结果。
func (e *WailsEditorEmitter) EmitEditorSaved(sessionID string, remotePath string, success bool, conflict bool, errMsg string) {
	e.app.Event.Emit(EditorSavedEvent, EditorSavedPayload{
		SessionID:  sessionID,
		RemotePath: remotePath,
		Success:    success,
		Conflict:   conflict,
		Error:      errMsg,
	})
}
