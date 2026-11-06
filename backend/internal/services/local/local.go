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
	"path/filepath"
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
	// shell 来自前端绑定调用：若接受任意路径，渲染进程被注入后可借 Start 启动
	// 任意本地程序。resolveShell 只返回受信任的系统 shell 绝对路径，
	// 其余输入一律回退平台默认值。
	shell = resolveShell(shell)

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

// allowedShellNames 是允许启动的系统 shell 文件名（小写）。
var allowedShellNames = map[string]struct{}{
	"pwsh.exe": {}, "pwsh": {}, "powershell.exe": {}, "powershell": {},
	"cmd.exe": {}, "cmd": {}, "bash.exe": {}, "bash": {}, "zsh.exe": {},
	"zsh": {}, "sh.exe": {}, "sh": {}, "fish.exe": {}, "fish": {},
	"dash": {},
}

// resolveShell 把前端传入的 shell 配置解析成受信任的系统 shell 绝对路径。
//
// 仅按文件名做白名单并不充分：任何目录下的 cmd.exe / bash 都会通过，
// 渲染进程被注入后可以借此启动任意本地程序；裸文件名还依赖 PATH（Windows
// 会优先命中当前工作目录）。因此这里要求最终路径位于系统 shell 的标准目录，
// 裸名也在这些目录中显式查找，而不是交给 exec.LookPath。
// 无法确认受信任时回退平台默认 shell。
func resolveShell(shell string) string {
	shell = strings.TrimSpace(shell)
	if shell == "" {
		return detectShell()
	}
	base := strings.ToLower(filepath.Base(shell))
	if _, ok := allowedShellNames[base]; !ok {
		return detectShell()
	}
	// 裸文件名：只在受信任目录中查找，避免 PATH / 当前目录劫持
	if !strings.ContainsAny(shell, `/\`) {
		if p := findShellInTrustedDirs(base); p != "" {
			return p
		}
		return detectShell()
	}
	abs, err := filepath.Abs(shell)
	if err != nil {
		return detectShell()
	}
	// 软链接最终指向的仍是可执行文件时才接受（/bin/sh -> /usr/bin/dash 等）
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		abs = resolved
	}
	if !isTrustedShellPath(abs) {
		return detectShell()
	}
	return abs
}

// findShellInTrustedDirs 在系统 shell 的标准安装目录中查找可执行文件。
func findShellInTrustedDirs(base string) string {
	for _, dir := range trustedShellDirs() {
		candidate := filepath.Join(dir, base)
		if isExecutableFile(candidate) {
			return candidate
		}
	}
	return ""
}

// isTrustedShellPath 判断绝对路径是否位于系统 shell 的标准目录下。
func isTrustedShellPath(abs string) bool {
	if !isExecutableFile(abs) {
		return false
	}
	for _, dir := range trustedShellDirs() {
		rel, err := filepath.Rel(dir, abs)
		if err != nil || rel == "." || strings.HasPrefix(rel, "..") {
			continue
		}
		return true
	}
	return false
}

// trustedShellDirs 返回当前平台存放系统 shell 的目录。
// Windows 额外包含 PowerShell 7 的安装目录与 WindowsApps（Store 版 pwsh）。
func trustedShellDirs() []string {
	if runtime.GOOS == "windows" {
		var dirs []string
		if root := os.Getenv("SystemRoot"); root != "" {
			dirs = append(dirs,
				filepath.Join(root, "System32"),
				filepath.Join(root, "System32", "WindowsPowerShell", "v1.0"),
				filepath.Join(root, "SysWOW64"),
			)
		}
		for _, env := range []string{"ProgramFiles", "ProgramFiles(x86)"} {
			if dir := os.Getenv(env); dir != "" {
				dirs = append(dirs, filepath.Join(dir, "PowerShell"))
			}
		}
		if dir := os.Getenv("LOCALAPPDATA"); dir != "" {
			dirs = append(dirs, filepath.Join(dir, "Microsoft", "WindowsApps"))
		}
		if len(dirs) == 0 {
			dirs = append(dirs, `C:\Windows\System32`)
		}
		return dirs
	}
	return []string{
		"/bin", "/usr/bin", "/usr/local/bin", "/usr/local/sbin",
		"/sbin", "/usr/sbin", "/opt/homebrew/bin", "/opt/local/bin",
		"/snap/bin", "/nix/store",
	}
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0 {
		return false
	}
	return true
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
