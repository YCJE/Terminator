// Package local 提供本地 shell 终端会话。
//
// 与 SSH 会话共用同一套前端数据事件（ssh:data / ssh:closed），
// 只是数据来源换成本机伪终端（Unix PTY / Windows ConPTY）。
// 会话 ID 由前端生成，与 SSH 会话的 ID 空间保持一致。
package local

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"

	"github.com/aymanbagabas/go-pty"
)

// Emitter 复用 SSH 的数据事件通道，前端无需区分数据来源。
type Emitter interface {
	EmitData(sessionID string, data []byte)
	EmitClosed(sessionID string)
}

type session struct {
	pty       pty.Pty
	cmd       *pty.Cmd
	closeOnce sync.Once
}

type LocalShellService struct {
	emitter  Emitter
	mu       sync.Mutex
	sessions map[string]*session
}

func NewLocalShellService(emitter Emitter) *LocalShellService {
	return &LocalShellService{
		emitter:  emitter,
		sessions: make(map[string]*session),
	}
}

// DefaultShell 返回当前平台的默认 shell 路径，供前端展示标题使用。
func (s *LocalShellService) DefaultShell() string {
	return detectShell()
}

// Start 启动一个本地 shell 会话。sessionID 为空时返回错误；
// 同一个 ID 上已有会话时先关闭旧会话，避免重连后残留两个 shell。
func (s *LocalShellService) Start(sessionID string, shell string) error {
	if strings.TrimSpace(sessionID) == "" {
		return errors.New("本地终端会话 ID 不能为空")
	}
	if strings.TrimSpace(shell) == "" {
		shell = detectShell()
	}

	p, err := pty.New()
	if err != nil {
		return fmt.Errorf("创建本地终端失败: %w", err)
	}

	cmd := p.Command(shell)
	cmd.Env = shellEnv()
	if home, err := os.UserHomeDir(); err == nil {
		cmd.Dir = home
	}
	// PowerShell 默认会打印版权横幅，加 -NoLogo 让首屏更干净；
	// 其他 shell 保持默认参数，避免影响用户的交互习惯。
	if isPowerShell(shell) {
		cmd.Args = []string{shell, "-NoLogo"}
	}

	if err := cmd.Start(); err != nil {
		_ = p.Close()
		return fmt.Errorf("启动本地终端失败: %w", err)
	}

	current := &session{pty: p, cmd: cmd}

	s.mu.Lock()
	previous := s.sessions[sessionID]
	s.sessions[sessionID] = current
	s.mu.Unlock()
	if previous != nil {
		s.teardown(sessionID, previous)
	}

	go s.readLoop(sessionID, current)
	go func() {
		// shell 退出（例如输入 exit）后回收资源并通知前端
		_ = cmd.Wait()
		s.teardown(sessionID, current)
	}()

	return nil
}

// Input 把键盘输入写入本地 shell。
func (s *LocalShellService) Input(sessionID string, data string) error {
	current := s.lookup(sessionID)
	if current == nil {
		return errors.New("本地终端会话不存在或已关闭")
	}
	_, err := current.pty.Write([]byte(data))
	return err
}

// Resize 调整伪终端窗口大小（列在前、行在后）。
func (s *LocalShellService) Resize(sessionID string, rows, cols int) error {
	if rows <= 0 || cols <= 0 {
		return nil
	}
	current := s.lookup(sessionID)
	if current == nil {
		return errors.New("本地终端会话不存在或已关闭")
	}
	return current.pty.Resize(cols, rows)
}

// Close 主动关闭本地会话（切换标签、重连清理时调用）。
// 不发送 closed 事件：调用方通常已经在销毁终端，避免误把新会话标记为断开。
func (s *LocalShellService) Close(sessionID string) {
	s.mu.Lock()
	current := s.sessions[sessionID]
	if current != nil {
		delete(s.sessions, sessionID)
	}
	s.mu.Unlock()
	if current != nil {
		s.teardown(sessionID, current)
	}
}

// CloseAll 关闭所有本地会话（应用退出、擦除数据时调用）。
func (s *LocalShellService) CloseAll() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.sessions))
	for id := range s.sessions {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.Close(id)
	}
}

func (s *LocalShellService) lookup(sessionID string) *session {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessions[sessionID]
}

// isCurrent 判断 current 是否仍是该 ID 对应的会话。
//
// 同一 ID 重启时旧会话的 readLoop 可能还有未读完的数据，若直接 Emit 会把
// 旧 shell 的残留输出混进新终端（例如上一条命令的回显/报错），必须丢弃。
func (s *LocalShellService) isCurrent(sessionID string, current *session) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessions[sessionID] == current
}

func (s *LocalShellService) readLoop(sessionID string, current *session) {
	buffer := make([]byte, 32*1024)
	for {
		n, err := current.pty.Read(buffer)
		if n > 0 && s.isCurrent(sessionID, current) {
			// emitter 内部会立即完成 base64 编码，复用缓冲区是安全的
			s.emitter.EmitData(sessionID, buffer[:n])
		}
		if err != nil {
			break
		}
	}
	s.teardown(sessionID, current)
}

// teardown 关闭 PTY 与子进程，并在该会话仍是当前会话时通知前端。
func (s *LocalShellService) teardown(sessionID string, current *session) {
	current.closeOnce.Do(func() {
		_ = current.pty.Close()
		if current.cmd.Process != nil {
			_ = current.cmd.Process.Kill()
		}

		s.mu.Lock()
		isCurrent := s.sessions[sessionID] == current
		if isCurrent {
			delete(s.sessions, sessionID)
		}
		s.mu.Unlock()

		if isCurrent {
			s.emitter.EmitClosed(sessionID)
		}
	})
}

func detectShell() string {
	if runtime.GOOS == "windows" {
		for _, name := range []string{"pwsh.exe", "powershell.exe"} {
			if path, err := exec.LookPath(name); err == nil {
				return path
			}
		}
		if comspec := os.Getenv("COMSPEC"); comspec != "" {
			return comspec
		}
		return "cmd.exe"
	}
	if shell := os.Getenv("SHELL"); shell != "" {
		return shell
	}
	for _, name := range []string{"/bin/bash", "/bin/zsh", "/bin/sh"} {
		if path, err := exec.LookPath(name); err == nil {
			return path
		}
	}
	return "/bin/sh"
}

// shellEnv 继承当前进程环境并补齐 TERM，保证程序输出标准 ANSI 序列。
func shellEnv() []string {
	env := os.Environ()
	for _, entry := range env {
		if strings.HasPrefix(entry, "TERM=") {
			return env
		}
	}
	return append(env, "TERM=xterm-256color")
}

func isPowerShell(path string) bool {
	base := strings.ToLower(path)
	return strings.Contains(base, "pwsh") || strings.Contains(base, "powershell")
}
