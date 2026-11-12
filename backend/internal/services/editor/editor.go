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

	"terminator-desktop/backend/internal/apperror"
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

	// 自动回传失败后的指数退避：一次网络/SFTP 抖动不应让本次修改永久丢失，
	// 也不能每 2 秒重试一次把错误提示刷屏。
	retryAt    time.Time
	retryDelay time.Duration
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

// executableEditorExtensions 是"双击即执行"而非"用编辑器查看"的扩展名。
//
// 远端文件来自用户连接的主机，内容完全不可信：把原名交给 Windows 的
// ShellExecute / macOS 的 open 打开时，.bat、.cmd、.exe、.lnk 等会被直接执行，
// 相当于让远端主机在本机落地任意代码。对这些扩展名追加 ".txt"，系统只会按
// 文本打开；其余扩展名保持不变以保留编辑器语法高亮。
var executableEditorExtensions = map[string]struct{}{
	".app": {}, ".appref-ms": {}, ".application": {}, ".bat": {}, ".cmd": {},
	".com": {}, ".command": {}, ".cpl": {}, ".dmg": {}, ".exe": {}, ".gadget": {},
	".hta": {}, ".jar": {}, ".js": {}, ".jse": {}, ".lnk": {}, ".mpkg": {},
	".msi": {}, ".msp": {}, ".msix": {}, ".appx": {}, ".pif": {}, ".pkg": {},
	".pl": {}, ".ps1": {}, ".psm1": {}, ".py": {}, ".pyw": {}, ".rb": {},
	".reg": {}, ".scpt": {}, ".scr": {}, ".terminal": {}, ".vbe": {}, ".vbs": {},
	".workflow": {}, ".wsf": {}, ".wsh": {},
}

// safeEditorFileName 避免不可信远端文件在本机被系统当作可执行文件打开。
func safeEditorFileName(name string) string {
	if _, bad := executableEditorExtensions[strings.ToLower(path.Ext(name))]; bad {
		return name + ".txt"
	}
	return name
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
	localPath := filepath.Join(localDir, safeEditorFileName(localEditorFileName(cleanRemote)))

	// 冲突基线必须与下载到的内容严格对应。先 Stat 再下载：若远端在两者之间被
	// 修改，下载到的已是新内容，而基线仍是旧版本，保存时会被误判成冲突；
	// 反过来只在下载后 Stat，又可能把"下载之后发生的修改"当成基线，
	// 保存时直接覆盖掉别人的改动。因此下载后重新 Stat，与下载前不一致就
	// 整体重下一遍，直到前后两次元信息一致（最多重试 3 轮，避免文件持续
	// 变动时无限循环）。
	baseline := info
	for attempt := 0; ; attempt++ {
		if err := downloadTo(client, cleanRemote, localPath); err != nil {
			_ = os.RemoveAll(localDir)
			return "", err
		}
		after, statErr := client.Stat(cleanRemote)
		if statErr != nil {
			_ = os.RemoveAll(localDir)
			return "", fmt.Errorf("读取远端文件 %q 信息失败: %w", cleanRemote, statErr)
		}
		if after.ModTime().Equal(baseline.ModTime()) && after.Size() == baseline.Size() {
			baseline = after
			break
		}
		if attempt >= 2 {
			_ = os.RemoveAll(localDir)
			return "", fmt.Errorf("远端文件 %q 正在被修改，请稍后再试", cleanRemote)
		}
		baseline = after
	}

	w := &watcher{
		key:        key,
		sessionID:  cleanSession,
		remotePath: cleanRemote,
		localDir:   localDir,
		localPath:  localPath,
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
		remoteMod:  baseline.ModTime(),
		remoteSize: baseline.Size(),
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
		// 监听尚未开始就失败（例如安全软件/同步盘瞬时移走文件）：
		// 必须注销 watcher 并清理临时目录，否则 s.watchers 永久残留，
		// 之后同一远端路径再次打开会命中这个失效条目，永远无法恢复。
		s.removeWatcher(w.key)
		_ = os.RemoveAll(w.localDir)
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
			// 用户重新编辑：立即允许下一次回传，并重置退避
			w.retryAt = time.Time{}
			w.retryDelay = 0
			// 用户又编辑了本地文件：即便上一轮已提示过远端冲突，也要重新提示。
			// 否则 conflictNotified 一旦置位就再也不会复位（上传永远被跳过），
			// 后续所有保存都会静默丢弃，编辑器却显示"已保存"。
			w.conflictNotified = false
			continue
		}
		if !dirty {
			continue
		}
		stable++
		if stable < quietTicks {
			continue
		}
		// 失败后的退避窗口内不重试，避免每两秒刷一次错误提示
		if !w.retryAt.IsZero() && time.Now().Before(w.retryAt) {
			continue
		}
		dirty = false
		stable = 0
		switch s.uploadBack(w) {
		case uploadOK:
			w.retryAt = time.Time{}
			w.retryDelay = 0
		case uploadConflict:
			// 冲突期间不自动重试：等用户再次编辑本地文件才会重新判定
			w.retryAt = time.Time{}
			w.retryDelay = 0
		case uploadFailed:
			// 瞬时故障：保留 dirty 并按指数退避重试，直到成功或用户重新编辑
			dirty = true
			if w.retryDelay == 0 {
				w.retryDelay = watchInterval * 2
			} else {
				w.retryDelay *= 2
			}
			if w.retryDelay > 30*time.Second {
				w.retryDelay = 30 * time.Second
			}
			w.retryAt = time.Now().Add(w.retryDelay)
		case uploadAbandoned:
			// 会话已不存在，重试永远不会成功：注销监听但保留本地文件，
			// 其中可能还有用户尚未回传的修改，删除后再也无法找回。
			s.removeWatcher(w.key)
			return
		}
	}
}

// uploadOutcome 描述一次自动回传的结果，决定监听循环是否继续重试。
type uploadOutcome int

const (
	uploadOK uploadOutcome = iota
	uploadConflict
	uploadFailed
	// uploadAbandoned 表示会话已不存在，继续重试没有意义，监听应结束
	uploadAbandoned
)

// isSessionGone 判断错误是否表示 SSH 会话已不存在（已断开或被重连替换）。
// 这类错误不会自行恢复：若按瞬时故障重试，监听会永远每隔几十秒推送一条
// 相同失败事件，而用户的修改始终没有机会回传。
func isSessionGone(err error) bool {
	var appErr *apperror.AppError
	return errors.As(err, &appErr) && appErr.Code == apperror.CodeSSHSessionNotFound
}

// uploadBack 把本地临时文件写回远端。远端在此期间被他人修改时只推送一次冲突事件。
func (s *Service) uploadBack(w *watcher) uploadOutcome {
	client, err := s.remote.GetSFTPClient(w.sessionID)
	if err != nil {
		s.emitter.EmitEditorSaved(w.sessionID, w.remotePath, false, false, err.Error())
		if isSessionGone(err) {
			return uploadAbandoned
		}
		return uploadFailed
	}

	// 必须先确认远端仍是我们下载时的版本。Stat 失败（非"不存在"）说明无法
	// 确认远端状态，此时继续写入会在远端被他人修改/删除时静默覆盖对方内容。
	info, statErr := client.Stat(w.remotePath)
	switch {
	case statErr == nil:
		// 远端大小或修改时间变化都说明内容已不是我们下载时的版本
		if !info.ModTime().Equal(w.remoteMod) || info.Size() != w.remoteSize {
			if !w.conflictNotified {
				w.conflictNotified = true
				s.emitter.EmitEditorSaved(
					w.sessionID, w.remotePath, false, true,
					"远端文件已被其他程序修改，已跳过本次自动保存",
				)
			}
			return uploadConflict
		}
	case os.IsNotExist(statErr):
		// 远端文件已被删除：自动保存不应把它重新创建出来
		if !w.conflictNotified {
			w.conflictNotified = true
			s.emitter.EmitEditorSaved(
				w.sessionID, w.remotePath, false, true,
				"远端文件已被删除，已跳过本次自动保存",
			)
		}
		return uploadConflict
	default:
		s.emitter.EmitEditorSaved(
			w.sessionID, w.remotePath, false, false,
			fmt.Sprintf("读取远端文件状态失败: %v", statErr),
		)
		return uploadFailed
	}

	if err := s.writer.WriteLocalFileToRemote(w.sessionID, w.localPath, w.remotePath); err != nil {
		s.emitter.EmitEditorSaved(w.sessionID, w.remotePath, false, false, err.Error())
		// Stat 与写入之间会话可能刚好断开，同样不能按瞬时故障无限重试
		if isSessionGone(err) {
			return uploadAbandoned
		}
		return uploadFailed
	}
	// 以本次写入后的远端状态作为下一轮基准，避免下一次保存被判成冲突。
	// 写回已成功，Stat 偶发失败时短暂重试；仍失败则保留旧基准，由下一轮的
	// 前置检查处理（那次失败会作为可重试错误而不是误报冲突）。
	for attempt := 0; attempt < 3; attempt++ {
		if info, statErr = client.Stat(w.remotePath); statErr == nil {
			w.remoteMod = info.ModTime()
			w.remoteSize = info.Size()
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	w.conflictNotified = false
	s.emitter.EmitEditorSaved(w.sessionID, w.remotePath, true, false, "")
	return uploadOK
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

// CleanupTempFiles 停止全部监听并删除各自的临时目录（擦除数据时调用）。
//
// 与 Close 不同：临时目录里保存着远端文件的完整副本，擦除数据时必须一并删除，
// 否则用户以为已清空，磁盘上仍留有一份可读的远端文件。
func (s *Service) CleanupTempFiles() {
	s.mu.Lock()
	list := make([]*watcher, 0, len(s.watchers))
	for _, w := range s.watchers {
		list = append(list, w)
	}
	s.watchers = make(map[string]*watcher)
	s.mu.Unlock()
	for _, w := range list {
		w.requestStop()
		_ = os.RemoveAll(w.localDir)
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
