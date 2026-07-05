package emitters

import "github.com/wailsapp/wails/v3/pkg/application"

// SFTP 传输相关事件名常量，前端据此监听进度与完成事件。
const (
	SFTPProgressEvent = "sftp:progress"
	SFTPCompleteEvent = "sftp:complete"
)

// SFTPTransferProgressPayload 传输进度事件的载荷。
type SFTPTransferProgressPayload struct {
	SessionID   string `json:"sessionId"`   // 所属 SSH 会话 ID
	TransferID  string `json:"transferId"`  // 本次传输的唯一 ID（前端生成）
	Filename    string `json:"filename"`    // 文件名（不含路径）
	Transferred int64  `json:"transferred"` // 已传输字节数
	Total       int64  `json:"total"`       // 文件总字节数
}

// SFTPTransferCompletePayload 传输完成事件的载荷。
type SFTPTransferCompletePayload struct {
	SessionID  string `json:"sessionId"`  // 所属 SSH 会话 ID
	TransferID string `json:"transferId"` // 本次传输的唯一 ID
	Success    bool   `json:"success"`    // 是否成功
	Error      string `json:"error"`      // 失败原因（成功时为空）
}

// WailsSFTPEmitter 通过 Wails 事件总线向前端推送 SFTP 传输进度与完成事件。
// 它实现了 sftp.SFTPEmitter 接口（结构化匹配，无需显式声明）。
type WailsSFTPEmitter struct {
	app *application.App
}

// NewWailsSFTPEmitter 创建基于 Wails 事件总线的 SFTP emitter。
func NewWailsSFTPEmitter(app *application.App) *WailsSFTPEmitter {
	return &WailsSFTPEmitter{app: app}
}

// EmitTransferProgress 推送单次传输的实时进度。
func (e *WailsSFTPEmitter) EmitTransferProgress(sessionID string, transferID string, filename string, transferred int64, total int64) {
	e.app.Event.Emit(SFTPProgressEvent, SFTPTransferProgressPayload{
		SessionID:   sessionID,
		TransferID:  transferID,
		Filename:    filename,
		Transferred: transferred,
		Total:       total,
	})
}

// EmitTransferComplete 推送传输完成事件（成功或失败）。
func (e *WailsSFTPEmitter) EmitTransferComplete(sessionID string, transferID string, success bool, errMsg string) {
	e.app.Event.Emit(SFTPCompleteEvent, SFTPTransferCompletePayload{
		SessionID:  sessionID,
		TransferID: transferID,
		Success:    success,
		Error:      errMsg,
	})
}
