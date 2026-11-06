// Package floating 提供"把终端会话移到独立窗口"的能力。
//
// 会话本身由 SSH / 本地终端服务持有，窗口只是同一进程内的另一个视图：
// 弹出与收回都不会重建连接，正在运行的命令不会被打断。
// 新窗口通过 URL fragment 携带一次性 token，再调用 TakeFloatingTerminal
// 取回启动参数；token 只存在于进程内存，不写入磁盘。
package floating

import (
	"errors"
	"runtime"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"terminator-desktop/backend/internal/services/ssh"
)

// DockRequestEvent 浮动窗口请求回到主窗口标签栏时发出的事件（全窗口广播）。
const DockRequestEvent = "floating:dock-request"

const (
	defaultWidth  = 960
	defaultHeight = 600
	minWidth      = 420
	minHeight     = 260
	maxWidth      = 3840
	maxHeight     = 2160
)

// Request 是主窗口发起的浮动窗口创建请求。
type Request struct {
	// SessionID 已存在的会话 ID：新窗口附着到该会话，而不是新建连接。
	SessionID string `json:"sessionId"`
	Title     string `json:"title"`
	// Kind 会话来源："ssh" 或 "local"
	Kind string `json:"kind"`
	// HostID 会话来源主机 ID（工作区恢复、书签与端口转发作用域都依赖它）。
	// 会话收回主窗口时必须原样带回，否则这些按主机归属的数据会退化为
	// user@host:port 作用域。
	HostID string                   `json:"hostId,omitempty"`
	Config *ssh.SSHConnectionConfig `json:"config,omitempty"`
	// Attach 为 true 表示新窗口附着到正在运行的会话；
	// 会话已断开时传 false，由新窗口重新建立连接。
	Attach bool `json:"attach"`
	// Width/Height 新窗口初始尺寸；<=0 时使用默认值
	Width       int  `json:"width,omitempty"`
	Height      int  `json:"height,omitempty"`
	AlwaysOnTop bool `json:"alwaysOnTop,omitempty"`
}

// Payload 是新窗口取回的启动参数：只包含重建终端视图所需的信息。
type Payload struct {
	SessionID string                   `json:"sessionId"`
	Title     string                   `json:"title"`
	Kind      string                   `json:"kind"`
	HostID    string                   `json:"hostId,omitempty"`
	Config    *ssh.SSHConnectionConfig `json:"config,omitempty"`
	Attach    bool                     `json:"attach"`
}

// DockPayload 随 DockRequestEvent 广播：主窗口据此把会话重新挂回标签栏。
type DockPayload struct {
	SessionID string                   `json:"sessionId"`
	Title     string                   `json:"title"`
	Kind      string                   `json:"kind"`
	HostID    string                   `json:"hostId,omitempty"`
	Config    *ssh.SSHConnectionConfig `json:"config,omitempty"`
	// Attach 为 false 时主窗口需要重新连接（浮动窗口中的会话已断开）
	Attach bool `json:"attach"`
}

type windowRecord struct {
	window  *application.WebviewWindow
	payload Payload
	// keepAlive 由 DockBack 置位：关闭窗口时不断开会话，所有权已交回主窗口
	keepAlive bool
}

type Service struct {
	app           *application.App
	sshDisconnect func(string)
	localClose    func(string)

	mu      sync.Mutex
	windows map[string]*windowRecord
}

// NewService 需要注入两个关闭函数：窗口关闭时若会话仍归它所有，必须释放后端连接。
func NewService(app *application.App, sshDisconnect, localClose func(string)) *Service {
	return &Service{
		app:           app,
		sshDisconnect: sshDisconnect,
		localClose:    localClose,
		windows:       make(map[string]*windowRecord),
	}
}

// OpenFloatingTerminal 创建独立终端窗口并返回窗口 token。
// 调用方（主窗口）随后应把该会话从标签栏移除，但保留后端连接。
func (s *Service) OpenFloatingTerminal(req Request) (string, error) {
	sessionID := strings.TrimSpace(req.SessionID)
	if sessionID == "" {
		return "", errors.New("浮动窗口缺少会话 ID")
	}
	kind := req.Kind
	if kind == "" {
		kind = "ssh"
	}
	if kind != "ssh" && kind != "local" {
		return "", errors.New("不支持的会话类型")
	}
	if kind == "ssh" && req.Config == nil {
		return "", errors.New("浮动窗口缺少 SSH 连接参数")
	}
	// 新窗口以会话 ID 附着到现有连接：配置里的 ID 必须与会话 ID 一致，
	// 否则前端按 config.id 重连时会落到另一个会话上。
	if req.Config != nil {
		req.Config.ID = sessionID
	}

	// 同一会话只能有一个浮动窗口：两个窗口共享同一后端会话，
	// 任一窗口关闭都会把连接断开，另一个窗口会莫名失效。
	// 这里先做一次快速检查（避免正常路径下白建窗口），登记时还会在锁内
	// 重新检查：两个并发请求都通过初始检查时，后登记的一方关闭自己新建的窗口。
	if err := s.ensureSessionFree(sessionID); err != nil {
		return "", err
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		title = "Terminator"
	}
	width := clampSize(req.Width, defaultWidth, minWidth, maxWidth)
	height := clampSize(req.Height, defaultHeight, minHeight, maxHeight)

	token := uuid.NewString()
	payload := Payload{
		SessionID: sessionID,
		Title:     title,
		Kind:      kind,
		HostID:    req.HostID,
		Config:    req.Config,
		Attach:    req.Attach,
	}

	win := s.app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "floating-" + token,
		Title:            title,
		Width:            width,
		Height:           height,
		MinWidth:         minWidth,
		MinHeight:        minHeight,
		AlwaysOnTop:      req.AlwaysOnTop,
		Frameless:        runtime.GOOS == "windows",
		BackgroundColour: application.NewRGB(9, 9, 11),
		URL:              "/#/floating?token=" + token,
		EnableFileDrop:   true,
		InitialPosition:  application.WindowCentered,
	})

	record := &windowRecord{window: win, payload: payload}
	s.mu.Lock()
	for _, existing := range s.windows {
		if existing.payload.SessionID == sessionID {
			s.mu.Unlock()
			// 竞态：另一个请求在初始检查之后登记了同一会话。放弃本次创建的窗口，
			// 否则两个窗口都会认为连接归自己所有。
			win.Close()
			return "", errors.New("该会话已在浮动窗口中打开")
		}
	}
	s.windows[token] = record
	s.mu.Unlock()

	win.OnWindowEvent(events.Common.WindowClosing, func(*application.WindowEvent) {
		s.handleWindowClosed(token)
	})
	return token, nil
}

// ensureSessionFree 检查该会话是否已有浮动窗口（调用方不应持有 s.mu）。
func (s *Service) ensureSessionFree(sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.windows {
		if existing.payload.SessionID == sessionID {
			return errors.New("该会话已在浮动窗口中打开")
		}
	}
	return nil
}

// TakeFloatingTerminal 返回窗口的启动参数。
// token 只在该窗口存活期间有效，窗口关闭后自然失效。
func (s *Service) TakeFloatingTerminal(token string) (*Payload, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	record, ok := s.windows[token]
	if !ok {
		return nil, errors.New("浮动窗口已关闭")
	}
	payload := record.payload
	return &payload, nil
}

// DockBack 把浮动窗口中的会话交回主窗口。
// 先置 keepAlive 再广播事件：主窗口收到事件后挂回标签，随后由前端关闭本窗口。
func (s *Service) DockBack(token string, attach bool) error {
	s.mu.Lock()
	record, ok := s.windows[token]
	if !ok {
		s.mu.Unlock()
		return errors.New("浮动窗口已关闭")
	}
	record.keepAlive = true
	payload := record.payload
	s.mu.Unlock()

	s.app.Event.Emit(DockRequestEvent, DockPayload{
		SessionID: payload.SessionID,
		Title:     payload.Title,
		Kind:      payload.Kind,
		HostID:    payload.HostID,
		Config:    payload.Config,
		Attach:    attach,
	})
	return nil
}

// SetFloatingAlwaysOnTop 切换窗口置顶状态。
func (s *Service) SetFloatingAlwaysOnTop(token string, top bool) error {
	s.mu.Lock()
	record, ok := s.windows[token]
	s.mu.Unlock()
	if !ok {
		return errors.New("浮动窗口已关闭")
	}
	record.window.SetAlwaysOnTop(top)
	return nil
}

// CloseAllFloatingWindows 关闭所有浮动窗口。
// 锁定保险库、擦除数据等"清空全部会话"的动作必须调用它：
// 浮动窗口中的会话不在主窗口的标签列表里，否则会漏掉它们的连接。
func (s *Service) CloseAllFloatingWindows() {
	s.mu.Lock()
	records := make([]*windowRecord, 0, len(s.windows))
	for _, record := range s.windows {
		records = append(records, record)
	}
	s.mu.Unlock()
	for _, record := range records {
		record.window.Close()
	}
}

// handleWindowClosed 释放窗口记录；会话仍归本窗口时关闭后端连接。
func (s *Service) handleWindowClosed(token string) {
	s.mu.Lock()
	record, ok := s.windows[token]
	delete(s.windows, token)
	s.mu.Unlock()
	if !ok || record.keepAlive {
		return
	}
	payload := record.payload
	if payload.Kind == "local" {
		s.localClose(payload.SessionID)
		return
	}
	s.sshDisconnect(payload.SessionID)
}

func clampSize(value, fallback, min, max int) int {
	if value <= 0 {
		return fallback
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}
