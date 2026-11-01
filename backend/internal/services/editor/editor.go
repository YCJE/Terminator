// Package editor 实现"用系统默认程序打开远端文件，保存后自动回传"。
//
// 流程：下载远端文件到临时目录 → 用系统默认程序打开 → 轮询本地文件变化 →
// 内容稳定后流式写回远端（临时文件 + 原子重命名，不会出现半截文件）。
// 远端文件在编辑期间被其他程序修改时不覆盖，改为推送冲突事件，由用户决定。
package editor

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	pkgSFTP "github.com/pkg/sftp"

	"terminator-desktop/backend/internal/services/sftp"
	"terminator-desktop/backend/internal/services/ssh"
)

// 监听参数
const (
	// watchInterval 本地文件的轮询间隔。轮询比文件系统通知简单且跨平台一致：
	// Windows 的目录变更通知在部分网络盘/同步目录上并不可靠。
	watchInterval = time.Second
	// quietTicks 连续多少个周期没有新变化才视为"保存完成"。
	// 编辑器常"写临时文件再改名"或分多次写入，过快回传会拿到半截内容。
	quietTicks = 2
	// maxFileBytes 允许外部编辑的最大文件字节数（64MB），避免把超大文件整体载入内存。
	maxFileBytes = 64 << 20
)

// EditorEmitter 编辑器回传结果的事件回调，由 emitters 层实现。
type EditorEmitter interface {
	// EmitEditorSaved 推送一次自动回传的结果。
	// conflict=true 表示远端文件已被他人修改、本次未回传。
	EmitEditorSaved(sessionID string, remotePath string, success bool, conflict bool, errMsg string)
}

// RemoteFS 是编辑所需的最小远端只读接口（便于单测替换）。
type RemoteFS interface {
	Stat(p string) (os.FileInfo, error)
	Open(p string) (io.ReadCloser, error)
}

// RemoteProvider 按会话提供远端只读访问。
type RemoteProvider interface {
	GetSFTPClient(sessionID string) (RemoteFS, error)
}

// RemoteWriter 覆盖写远端文件（由 sftp.SftpService 实现）。
type RemoteWriter interface {
	WriteLocalFileToRemote(sessionID string, localPath string, remotePath string) error
}

// sshRemoteProvider 包装 ssh.SshService，把 *sftp.Client 适配成 RemoteFS。
type sshRemoteProvider struct {
	svc *ssh.SshService
}

func (p sshRemoteProvider) GetSFTPClient(sessionID string) (RemoteFS, error) {
	client, err := p.svc.GetSFTPClient(sessionID)
	if err != nil {
		return nil, err
	}
	return sftpRemote{client: client}, nil
}

// sftpRemote 把 *pkg/sftp.Client 收敛成 RemoteFS（其 Open 返回 *sftp.File，
// 与 io.ReadCloser 的方法签名不一致，需单独适配）。
type sftpRemote struct {
	client *pkgSFTP.Client
}

func (r sftpRemote) Stat(p string) (os.FileInfo, error) {
	return r.client.Stat(p)
}

func (r sftpRemote) Open(p string) (io.ReadCloser, error) {
	return r.client.Open(p)
}

// watcher 是一次外部编辑的监听状态。
type watcher struct {
	key        string
	sessionID  string
	remotePath string
	localDir   string
	localPath  string

	stop     chan struct{}
	stopOnce sync.Once
	done     chan struct{}

	// 打开时的远端元信息：用于检测编辑期间远端是否被其他程序修改
	remoteMod  time.Time
	remoteSize int64

	// conflictNotified 冲突只提示一次，避免用户每次编辑都收到同一条告警
	conflictNotified bool
}

func (w *watcher) requestStop() {
	w.stopOnce.Do(func() { close(w.stop) })
}

// Service 用系统默认程序编辑远端文件，并在保存后自动回传。
type Service struct {
	remote  RemoteProvider
	writer  RemoteWriter
	emitter EditorEmitter

	mu       sync.Mutex
	watchers map[string]*watcher
}

// NewService 创建外部编辑服务。
func NewService(sshSvc *ssh.SshService, sftpSvc *sftp.SftpService, emitter EditorEmitter) *Service {
	return newService(sshRemoteProvider{svc: sshSvc}, sftpSvc, emitter)
}

// newService 允许单测用假实现替换远端访问。
func newService(remote RemoteProvider, writer RemoteWriter, emitter EditorEmitter) *Service {
	return &Service{
		remote:   remote,
		writer:   writer,
		emitter:  emitter,
		watchers: make(map[string]*watcher),
	}
}

// editKey 以会话 + 远端路径作为一次编辑的唯一标识。
func editKey(sessionID string, remotePath string) string {
	return sessionID + "\n" + remotePath
}

// localEditorFileName 由远端路径推导本地临时文件名。
// 保留扩展名便于编辑器高亮；剔除路径分隔符等非法字符，
// 避免在 Windows 上创建文件失败。
func localEditorFileName(remotePath string) string {
	base := strings.TrimSpace(path.Base(remotePath))
	if base == "" || base == "." || base == ".." || base == "/" {
		base = "remote-file"
	}
	clean := strings.NewReplacer(
		"/", "_", "\\", "_", ":", "_", "*", "_", "?", "_",
		`"`, "_", "<", "_", ">", "_", "|", "_",
	).Replace(base)
	// 控制字符（含换行）在文件名里无意义，一并剔除
	clean = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, clean)
	if clean == "" {
		return "remote-file"
	}
	return clean
}

// openWithDefaultApp 用系统默认程序打开本地文件。
func openWithDefaultApp(localPath string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", localPath)
	case "darwin":
		cmd = exec.Command("open", localPath)
	default:
		cmd = exec.Command("xdg-open", localPath)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("打开外部编辑器失败: %w", err)
	}
	// 等待子进程退出，避免在 Unix 上留下僵尸进程
	go func() { _ = cmd.Wait() }()
	return nil
}

// OpenRemoteFile 下载远端文件并用系统默认程序打开，返回本地临时文件路径。
// 同一（会话, 路径）重复调用不会重复下载：复用已有临时文件与监听，
// 只重新拉起一次编辑器（例如用户关掉了编辑器窗口）。
func (s *Service) OpenRemoteFile(sessionID string, remotePath string) (string, error) {
	cleanSession := strings.TrimSpace(sessionID)
	cleanRemote := path.Clean(strings.TrimSpace(remotePath))
	if cleanSession == "" || strings.TrimSpace(remotePath) == "" || cleanRemote == "." {
		return "", errors.New("会话与远端路径不能为空")
	}

	key := editKey(cleanSession, cleanRemote)
	s.mu.Lock()
	existing := s.watchers[key]
	s.mu.Unlock()
	if existing != nil {
		if err := openWithDefaultApp(existing.localPath); err != nil {
			return "", err
		}
		return existing.localPath, nil
	}

	client, err := s.remote.GetSFTPClient(cleanSession)
	if err != nil {
		return "", err
	}
	info, err := client.Stat(cleanRemote)
	if err != nil {
		return "", fmt.Errorf("读取远端文件 %q 信息失败: %w", cleanRemote, err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%q 是目录，无法用编辑器打开", cleanRemote)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%q 不是常规文件，无法用编辑器打开", cleanRemote)
	}
	if info.Size() > maxFileBytes {
		return "", fmt.Errorf("文件超过 %d MB，请先下载后再编辑", maxFileBytes>>20)
	}

	localDir, err := os.MkdirTemp("", "terminator-edit-*")
	if err != nil {
		return "", fmt.Errorf("创建临时目录失败: %w", err)
	}
	localPath := filepath.Join(localDir, localEditorFileName(cleanRemote))
	if err := downloadTo(client, cleanRemote, localPath); err != nil {
		_ = os.RemoveAll(localDir)
		return "", err
	}

	w := &watcher{
		key:        key,
		sessionID:  cleanSession,
		remotePath: cleanRemote,
		localDir:   localDir,
		localPath:  localPath,
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
		remoteMod:  info.ModTime(),
		remoteSize: info.Size(),
	}

	s.mu.Lock()
	// 双检：并发打开同一文件时保留先注册的监听，后来的复用其临时文件
	if current, ok := s.watchers[key]; ok {
		s.mu.Unlock()
		_ = os.RemoveAll(localDir)
		if err := openWithDefaultApp(current.localPath); err != nil {
			return "", err
		}
		return current.localPath, nil
	}
	s.watchers[key] = w
	s.mu.Unlock()

	if err := openWithDefaultApp(localPath); err != nil {
		s.removeWatcher(key)
		_ = os.RemoveAll(localDir)
		return "", err
	}

	go s.watch(w)
	return localPath, nil
}

// downloadTo 把远端常规文件完整写入本地路径。
func downloadTo(remote RemoteFS, remotePath string, localPath string) error {
	src, err := remote.Open(remotePath)
	if err != nil {
		return fmt.Errorf("打开远端文件 %q 失败: %w", remotePath, err)
	}
	defer src.Close()

	dst, err := os.OpenFile(localPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("创建本地临时文件失败: %w", err)
	}
	if _, err := io.Copy(dst, src); err != nil {
		_ = dst.Close()
		_ = os.Remove(localPath)
		return fmt.Errorf("下载远端文件 %q 失败: %w", remotePath, err)
	}
	if err := dst.Close(); err != nil {
		_ = os.Remove(localPath)
		return fmt.Errorf("写入本地临时文件失败: %w", err)
	}
	return nil
}

// watch 轮询本地文件变化并在内容稳定后回传，直到监听被停止或临时文件消失。
func (s *Service) watch(w *watcher) {
	defer close(w.done)

	ticker := time.NewTicker(watchInterval)
	defer ticker.Stop()

	info, err := os.Stat(w.localPath)
	if err != nil {
		return
	}
	lastMod := info.ModTime()
	lastSize := info.Size()
	dirty := false
	stable := 0

	for {
		select {
		case <-w.stop:
			return
		case <-ticker.C:
		}

		info, err := os.Stat(w.localPath)
		if err != nil {
			if os.IsNotExist(err) {
				// 本地临时文件被删除：结束监听并清理临时目录
				s.removeWatcher(w.key)
				_ = os.RemoveAll(w.localDir)
				return
			}
			continue
		}
		if !info.ModTime().Equal(lastMod) || info.Size() != lastSize {
			lastMod = info.ModTime()
			lastSize = info.Size()
			dirty = true
			stable = 0
			continue
		}
		if !dirty {
			continue
		}
		stable++
		if stable < quietTicks {
			continue
		}
		dirty = false
		stable = 0
		s.uploadBack(w)
	}
}

// uploadBack 把本地临时文件写回远端。远端在此期间被他人修改时只推送一次冲突事件。
func (s *Service) uploadBack(w *watcher) {
	client, err := s.remote.GetSFTPClient(w.sessionID)
	if err != nil {
		s.emitter.EmitEditorSaved(w.sessionID, w.remotePath, false, false, err.Error())
		return
	}
	if info, statErr := client.Stat(w.remotePath); statErr == nil {
		// 远端大小或修改时间变化都说明内容已不是我们下载时的版本
		if !info.ModTime().Equal(w.remoteMod) || info.Size() != w.remoteSize {
			if !w.conflictNotified {
				w.conflictNotified = true
				s.emitter.EmitEditorSaved(
					w.sessionID, w.remotePath, false, true,
					"远端文件已被其他程序修改，已跳过本次自动保存",
				)
			}
			return
		}
	}

	if err := s.writer.WriteLocalFileToRemote(w.sessionID, w.localPath, w.remotePath); err != nil {
		s.emitter.EmitEditorSaved(w.sessionID, w.remotePath, false, false, err.Error())
		return
	}
	// 以本次写入后的远端状态作为下一轮基准，避免下一次保存被判成冲突
	if info, statErr := client.Stat(w.remotePath); statErr == nil {
		w.remoteMod = info.ModTime()
		w.remoteSize = info.Size()
	}
	w.conflictNotified = false
	s.emitter.EmitEditorSaved(w.sessionID, w.remotePath, true, false, "")
}

// removeWatcher 注销监听并停止其轮询协程。
func (s *Service) removeWatcher(key string) {
	s.mu.Lock()
	w, ok := s.watchers[key]
	if ok {
		delete(s.watchers, key)
	}
	s.mu.Unlock()
	if ok {
		w.requestStop()
	}
}

// Close 停止所有监听协程（关闭应用或切换保险库时调用）。
// 临时文件保留在磁盘上，用户仍可用编辑器继续查看。
func (s *Service) Close() {
	s.mu.Lock()
	list := make([]*watcher, 0, len(s.watchers))
	for _, w := range s.watchers {
		list = append(list, w)
	}
	s.watchers = make(map[string]*watcher)
	s.mu.Unlock()
	for _, w := range list {
		w.requestStop()
	}
}
