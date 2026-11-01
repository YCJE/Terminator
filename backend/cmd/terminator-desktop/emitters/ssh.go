package emitters

import (
	"encoding/base64"

	sshsvc "terminator-desktop/backend/internal/services/ssh"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type WailsSSHEmitter struct {
	app *application.App
}

type SSHDataPayload struct {
	ID   string `json:"id"`
	Data string `json:"data"`
}

type SSHClosedPayload struct {
	ID string `json:"id"`
}

// SSHAuthPromptPayload 对应 ssh.AuthPromptRequest 的前端结构。
type SSHAuthPromptPayload struct {
	RequestID   string        `json:"requestId"`
	SessionID   string        `json:"sessionId"`
	Host        string        `json:"host"`
	Username    string        `json:"username"`
	Instruction string        `json:"instruction"`
	Prompts     []SSHAuthItem `json:"prompts"`
}

type SSHAuthItem struct {
	Prompt string `json:"prompt"`
	Echo   bool   `json:"echo"`
}

const (
	SSHDataEvent   = "ssh:data"
	SSHClosedEvent = "ssh:closed"
	// SSHAuthPromptEvent 交互式认证问答：前端弹窗填写后回传 SubmitAuthResponses
	SSHAuthPromptEvent = "ssh:auth-prompt"
)

func NewWailsSSHEmitter(app *application.App) *WailsSSHEmitter {
	return &WailsSSHEmitter{app: app}
}

func (e *WailsSSHEmitter) EmitData(sessionID string, data []byte) {
	e.app.Event.Emit(SSHDataEvent, SSHDataPayload{
		ID:   sessionID,
		Data: base64.StdEncoding.EncodeToString(data),
	})
}

func (e *WailsSSHEmitter) EmitClosed(sessionID string) {
	e.app.Event.Emit(SSHClosedEvent, SSHClosedPayload{
		ID: sessionID,
	})
}

// EmitAuthPrompt 把服务器发起的交互式认证问答推送到前端。
func (e *WailsSSHEmitter) EmitAuthPrompt(request sshsvc.AuthPromptRequest) {
	items := make([]SSHAuthItem, len(request.Prompts))
	for i, prompt := range request.Prompts {
		items[i] = SSHAuthItem{Prompt: prompt.Prompt, Echo: prompt.Echo}
	}
	e.app.Event.Emit(SSHAuthPromptEvent, SSHAuthPromptPayload{
		RequestID:   request.RequestID,
		SessionID:   request.SessionID,
		Host:        request.Host,
		Username:    request.Username,
		Instruction: request.Instruction,
		Prompts:     items,
	})
}
