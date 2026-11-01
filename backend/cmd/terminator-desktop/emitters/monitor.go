package emitters

import (
	"terminator-desktop/backend/internal/services/monitor"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// 监控相关事件名常量，前端据此监听采样数据与错误。
const (
	MonitorSampleEvent = "monitor:sample"
	MonitorErrorEvent  = "monitor:error"
)

// MonitorErrorPayload 采集失败事件的载荷。
type MonitorErrorPayload struct {
	SessionID string `json:"sessionId"` // 所属 SSH 会话 ID
	Message   string `json:"message"`   // 失败原因
}

// WailsMonitorEmitter 通过 Wails 事件总线向前端推送监控采样。
// 它实现了 monitor.Emitter 接口（结构化匹配，无需显式声明）。
type WailsMonitorEmitter struct {
	app *application.App
}

func NewWailsMonitorEmitter(app *application.App) *WailsMonitorEmitter {
	return &WailsMonitorEmitter{app: app}
}

// EmitMonitorSample 推送一次完整采样。
func (e *WailsMonitorEmitter) EmitMonitorSample(sample monitor.MonitorSample) {
	e.app.Event.Emit(MonitorSampleEvent, sample)
}

// EmitMonitorError 推送采集失败通知；前端据此停止面板刷新并提示原因。
func (e *WailsMonitorEmitter) EmitMonitorError(sessionID string, message string) {
	e.app.Event.Emit(MonitorErrorEvent, MonitorErrorPayload{
		SessionID: sessionID,
		Message:   message,
	})
}
