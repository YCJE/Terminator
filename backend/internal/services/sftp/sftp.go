// Package sftp 实现基于现有 SSH 连接的 SFTP 文件管理能力。
// 它复用 SshService 持有的 *ssh.Client，通过 SFTP 子系统提供目录浏览、
// 文件读写、上传下载（带进度事件）等操作，供前端 Wails 绑定直接调用。
package sftp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"

	"terminator-desktop/backend/internal/services/ssh"
)

// SFTPEmitter 定义 SFTP 传输进度与完成事件的回调接口。
// 由 emitters 层实现（WailsSFTPEmitter），通过 Wails 事件总线推送给前端。
type SFTPEmitter interface {
	// EmitTransferProgress 推送单次传输的实时进度。
	// transferred 为已传输字节数，total 为文件总大小。
	EmitTransferProgress(sessionID string, transferID string, filename string, transferred int64, total int64)
	// EmitTransferComplete 推送传输完成事件（成功或失败）。
	EmitTransferComplete(sessionID string, transferID string, success bool, err string)
}

// FileEntry 描述远程文件系统中的一个条目（文件或目录）。
type FileEntry struct {
	Name      string `json:"name"`      // 条目名称（不含路径）
	Size      int64  `json:"size"`      // 字节数，目录通常为 0
	Mode      string `json:"mode"`      // 权限字符串，如 "drwxr-xr-x"
	ModTime   string `json:"modTime"`   // 修改时间，RFC3339 格式
	IsDir     bool   `json:"isDir"`     // 是否为目录
	IsSymlink bool   `json:"isSymlink"` // 是否为符号链接
}

// 传输相关常量
const (
	// transferChunkSize 单次读写的数据块大小
	// 32KB 太小导致进度事件过频（大文件每秒数百次），改为 256KB 减少事件频率
	transferChunkSize = 256 * 1024
	// maxReadFileSize ReadFile 允许读取的最大字节数（1MB），防止读取过大文件耗尽内存
	maxReadFileSize = 1 << 20
	// minTailBytes / maxTailBytes ReadFileTail 允许读取的尾部字节区间。
	// 下限保证少量数据也能覆盖最近若干条命令，上限避免一次读回过多内容。
	minTailBytes = 4 << 10
	maxTailBytes = 8 << 20
	// progressEmitInterval 进度事件最小发射间隔，避免高频事件淹没前端
	progressEmitInterval = 200 * time.Millisecond
	// partSuffix 续传临时文件后缀。传输过程始终写入该文件，全部完成后再
	// 原子重命名到目标路径：中断不会留下半截的目标文件，重试时按已有大小续传。
	partSuffix = ".terminator-part"
)

// transferIdentity 描述一次传输的源端身份：源文件修改时间 + 前端传输 ID。
//
// 仅凭总字节数无法区分"同尺寸但内容不同"的源文件（例如把配置里的端口从
// 8080 改成 9090 后重传同一远端路径），旧断点会被直接续上，拼出半旧半新的
// 文件且最终以原子重命名伪装成成功。加入修改时间后，源文件一旦变化就会
// 使用新的临时文件，从 0 重新传输。
//
// 同时带上传输 ID：两个不同传输写同一目标路径时不会共用同一个临时文件，
// 避免交错写入后被重命名成"成功"的损坏文件。续传沿用原传输 ID，
// 因此暂停后重试仍能命中同一个断点。
func transferIdentity(modTime time.Time, transferID string) string {
	return fmt.Sprintf("%d|%s", modTime.UnixNano(), transferID)
}

// partPath 返回目标路径对应的续传临时文件路径。
//
// 名称包含传输总字节数与源端身份的短摘要：源文件大小/修改时间变化，
// 或换成另一次传输时，旧断点都不会被错误复用。
func partPath(path string, total int64, identity string) string {
	sum := sha256.Sum256([]byte(identity))
	return fmt.Sprintf("%s%s-%d-%x", path, partSuffix, total, sum[:4])
}

// localResumeOffset 探测本地续传起点：临时文件存在且大小严格小于源文件总
// 大小时从该大小继续，否则返回 0 从头开始。大小不小于 total 说明源文件已
// 变化（变短或内容不同），续传会得到错误内容，故从头重来。
func localResumeOffset(part string, total int64) int64 {
	info, err := os.Stat(part)
	if err != nil || info.IsDir() {
		return 0
	}
	if size := info.Size(); size > 0 && size < total {
		return size
	}
	return 0
}

// renameOver 将 from 原子重命名为 to，目标存在时覆盖。
// PosixRename 是 POSIX 语义的原子重命名，部分服务器不支持该扩展，
// 回退到标准 Rename；两者都不支持覆盖已存在目标时，走"备份-替换-还原"流程。
func renameOver(client *sftp.Client, from string, to string) error {
	if err := client.PosixRename(from, to); err == nil {
		return nil
	}
	renameErr := client.Rename(from, to)
	if renameErr == nil {
		return nil
	}
	return replaceViaBackup(client, from, to, renameErr)
}

// replaceViaBackup 在服务器不支持覆盖式重命名时，用"目标改名备份 → 源改名到目标
// → 删除备份"三步完成替换。
//
// 部分 NAS/嵌入式 SFTP 服务端既不支持 posix-rename 扩展，标准 rename 又会在
// 目标已存在时返回 SSH_FX_FAILURE。此时直接报错会让用户已完整上传的数据被
// 丢弃（调用方删除临时文件），下次还得从头重传；而先删目标再改名，一旦改名
// 失败就会丢失原文件。这里用备份路径兜底：失败时尽力还原目标，实在无法还原
// 也会在错误里给出备份路径，数据仍可人工找回。
func replaceViaBackup(client *sftp.Client, from string, to string, cause error) error {
	// 目标不存在却重命名失败，说明是权限/只读等其它原因，不适用覆盖流程
	if _, err := client.Lstat(to); err != nil {
		return fmt.Errorf("重命名 %q -> %q 失败: %w", from, to, cause)
	}

	var suffix [6]byte
	_, _ = rand.Read(suffix[:])
	backup := fmt.Sprintf("%s.terminator-old-%x", to, suffix)
	if err := client.Rename(to, backup); err != nil {
		return fmt.Errorf("重命名 %q -> %q 失败: %w", from, to, cause)
	}
	if err := client.Rename(from, to); err != nil {
		// 还原原目标文件；还原失败时明确告知备份路径，避免用户以为文件丢失
		if restoreErr := client.Rename(backup, to); restoreErr != nil {
			return fmt.Errorf("重命名 %q -> %q 失败: %w；原文件已保存为 %q，自动还原失败: %v",
				from, to, cause, backup, restoreErr)
		}
		return fmt.Errorf("重命名 %q -> %q 失败: %w", from, to, cause)
	}
	// 备份不再需要；删除失败只留下一个临时文件，不影响替换结果
	_ = client.Remove(backup)
	return nil
}

// chmodForOverwrite 在临时文件上恢复原文件权限，并保证失败时不会放宽权限。
//
// 部分 SFTP 服务端不支持 setstat（Windows OpenSSH、部分 NAS/嵌入式设备），
// Chmod 必然失败。若一律把失败当成写入失败，这些服务器上的"编辑保存"与
// "外部编辑器回传"会彻底不可用。这里改为先比较临时文件的当前权限：
// 只要它带有原文件没有的权限位（例如原文件 0600、临时文件 0644），
// 继续重命名就会让敏感内容对他人可读，必须中止；否则（如仅丢失执行位）
// 继续完成保存，避免为了权限细节让用户无法保存文件。
func chmodForOverwrite(client *sftp.Client, tmpPath string, origMode os.FileMode) error {
	if err := client.Chmod(tmpPath, origMode); err == nil {
		return nil
	} else {
		info, statErr := client.Stat(tmpPath)
		if statErr != nil {
			// 无法确认权限时保持保守：宁可不保存，也不写入可能放宽权限的文件
			return fmt.Errorf("恢复临时文件权限失败（无法读取当前权限）: %w", err)
		}
		if widened := info.Mode().Perm() &^ origMode.Perm(); widened != 0 {
			return fmt.Errorf("恢复临时文件权限失败：临时文件权限 %04o 比原文件 %04o 更宽松: %w",
				info.Mode().Perm(), origMode.Perm(), err)
		}
		return nil
	}
}

// openRemoteForResume 打开远程临时文件用于写入，返回实际生效的起始偏移。
//
// 续传不使用 O_APPEND：SFTP 的写入请求带显式偏移，pkg/sftp 的 *File 从 0 开始
// 跟踪写入位置，部分服务器又忽略 append 标志，追加打开后会从文件头覆盖而不是
// 续写，最终把半截内容重命名成"成功"的文件。这里改为普通打开、以打开后
// 查到的大小为准 Seek 到断点：无论服务器是否支持/忽略 append 标志，
// 写入偏移都与文件现有长度一致。
//
// 临时文件为空、长度已达到甚至超过源文件总长（旧断点来自已变化的源文件），
// 或无法确认长度时，截断到 0 从头重传，避免旧内容的尾部残留在新文件里。
func openRemoteForResume(client *sftp.Client, part string, total int64) (*sftp.File, int64, error) {
	f, err := client.OpenFile(part, os.O_WRONLY|os.O_CREATE)
	if err != nil {
		return nil, 0, err
	}

	restart := func(reason error) (*sftp.File, int64, error) {
		// 截断而不是仅 Seek(0)：残留的旧内容会在写到 total 之前一直留在文件尾，
		// 重命名后得到一个比源文件更长、尾部是旧数据的损坏文件。
		if terr := f.Truncate(0); terr != nil {
			_ = f.Close()
			return nil, 0, fmt.Errorf("重置远程临时文件 %q 失败: %w（续传起点不可用: %v）", part, terr, reason)
		}
		if _, serr := f.Seek(0, io.SeekStart); serr != nil {
			_ = f.Close()
			return nil, 0, fmt.Errorf("定位远程临时文件 %q 失败: %w", part, serr)
		}
		return f, 0, nil
	}

	info, err := f.Stat()
	if err != nil || info.IsDir() {
		return restart(err)
	}
	size := info.Size()
	if size <= 0 || size >= total {
		return restart(fmt.Errorf("临时文件大小 %d 不适合续传", size))
	}
	if _, err := f.Seek(size, io.SeekStart); err != nil {
		return restart(err)
	}
	return f, size, nil
}

// SftpService 提供 SFTP 文件管理能力，作为 Wails 服务注册。
// 它不持有连接本身，而是通过 SshService 按需获取（懒加载的）SFTP 客户端。
type SftpService struct {
	sshSvc  *ssh.SshService
	emitter SFTPEmitter

	// mu 保护 cancels：记录进行中的传输，供 CancelTransfer 中断。
	mu      sync.Mutex
	cancels map[string]*transferCancel
}

// transferCancel 是一次传输的取消句柄。
// 用独立对象而非裸 CancelFunc 保存在 map 中：暂停后续传会复用同一 transferID，
// 旧传输的清理函数需要能判断"当前登记的是否仍是自己"，否则会把新传输的句柄删掉，
// 导致续传后的任务再也无法取消。
type transferCancel struct {
	cancel context.CancelFunc
	// done 在传输主体结束时关闭，供同一 transferID 的下一次传输等待交接。
	done chan struct{}
	// once 保证 done 只关闭一次（注销函数可能被重复调用）。
	once sync.Once
}

// NewSftpService 创建 SFTP 文件管理服务。
// sshSvc 用于获取已建立 SSH 连接的 SFTP 客户端；emitter 用于推送传输进度事件。
func NewSftpService(sshSvc *ssh.SshService, emitter SFTPEmitter) *SftpService {
	return &SftpService{
		sshSvc:  sshSvc,
		emitter: emitter,
		cancels: make(map[string]*transferCancel),
	}
}

// errTransferCanceled 表示用户主动取消了传输。
// 前端按该文案识别并显示"已取消"而不是普通失败。
var errTransferCanceled = errors.New("传输已取消")

// transferHandoverTimeout 是续传时等待上一次传输退出的最长时间。
// 取消只会让复制循环在下一个数据块前退出，正常情况下远小于该值；
// 只有连接假死、写入阻塞时才会等满。
const transferHandoverTimeout = 10 * time.Second

// registerTransfer 为一次传输注册取消句柄，返回上下文与注销函数。
// 注销函数同时清除记录，避免 map 随传输次数无限增长。
//
// 同一 transferID 只允许一个传输在写：续传会复用 ID 与同一个断点临时文件，
// 若上一次传输尚未退出（例如前端 2.5 秒兜底已把状态标成"已暂停"，但后端
// 仍阻塞在写入上），两个任务会并发写同一个文件，拼出损坏内容。
// 因此先取消旧任务并等待其退出；超时则拒绝本次传输，由前端提示重试。
func (s *SftpService) registerTransfer(transferID string) (context.Context, func(), error) {
	ctx, cancel := context.WithCancel(context.Background())
	entry := &transferCancel{cancel: cancel, done: make(chan struct{})}

	s.mu.Lock()
	previous := s.cancels[transferID]
	s.cancels[transferID] = entry
	s.mu.Unlock()

	fail := func() (context.Context, func(), error) {
		s.mu.Lock()
		if current, ok := s.cancels[transferID]; ok && current == entry {
			delete(s.cancels, transferID)
		}
		s.mu.Unlock()
		cancel()
		entry.once.Do(func() { close(entry.done) })
		return nil, nil, fmt.Errorf("上一次传输尚未结束，请稍后重试")
	}

	if previous != nil {
		previous.cancel()
		select {
		case <-previous.done:
		case <-time.After(transferHandoverTimeout):
			return fail()
		}
	}

	return ctx, func() {
		cancel()
		entry.once.Do(func() { close(entry.done) })
		s.mu.Lock()
		// 只删除本次注册的条目：续传会复用 transferID，若此时新传输已登记，
		// 无条件 delete 会把新任务从 CancelTransfer 的索引里抹掉。
		if current, ok := s.cancels[transferID]; ok && current == entry {
			delete(s.cancels, transferID)
		}
		s.mu.Unlock()
	}, nil
}

// CancelTransfer 取消进行中的传输。
// 传输结束后会推送一次失败完成事件（错误为"传输已取消"），
// 未在传输中的数据块不会落盘，已写入的续传临时文件保留供下次续传。
func (s *SftpService) CancelTransfer(transferID string) {
	s.mu.Lock()
	entry := s.cancels[transferID]
	s.mu.Unlock()
	if entry != nil {
		entry.cancel()
	}
}

// checkCanceled 在复制循环中检查取消信号。
func checkCanceled(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return errTransferCanceled
	default:
		return nil
	}
}

// ListDir 列出指定远程目录下的所有条目。
// 返回的列表按名称排序（sftp.ReadDir 已排序），不包含 "." 与 ".."。
func (s *SftpService) ListDir(sessionID string, path string) ([]FileEntry, error) {
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		return nil, err
	}

	infos, err := client.ReadDir(path)
	if err != nil {
		// 转小写匹配，兼容不同 SFTP 服务器的错误信息大小写差异
		lowerErr := strings.ToLower(err.Error())
		// 连接级错误（EOF/network reset）不重试，直接返回
		if strings.Contains(lowerErr, "eof") ||
			strings.Contains(lowerErr, "connection reset") ||
			strings.Contains(lowerErr, "broken pipe") {
			return nil, fmt.Errorf("读取目录 %q 失败: SSH 连接已断开", path)
		}
		// 权限错误等非连接级错误，直接返回不重置客户端
		// 避免重置 SFTP 客户端影响其他正在进行的传输操作
		if strings.Contains(lowerErr, "permission denied") ||
			strings.Contains(lowerErr, "not permitted") ||
			strings.Contains(lowerErr, "no such file") ||
			strings.Contains(lowerErr, "does not exist") {
			return nil, fmt.Errorf("读取目录 %q 失败: %w", path, err)
		}
		// 其他 SFTP 错误（如通道临时失效）：用独立的新客户端重试一次。
		// 不能 Reset 会话共享的客户端——它上面可能正有并发的上传/下载在跑，
		// 关掉它会把那些传输一并打断（报 EOF）。新建独立客户端可隔离影响。
		retryClient, err2 := s.sshSvc.NewSFTPClient(sessionID)
		if err2 != nil {
			// 会话已不存在，返回原始错误
			return nil, fmt.Errorf("读取目录 %q 失败: %w", path, err)
		}
		infos, err = retryClient.ReadDir(path)
		if err != nil {
			_ = retryClient.Close()
			return nil, fmt.Errorf("读取目录 %q 失败(重试后): %w", path, err)
		}
		// 重试客户端已证明可用：替换会话中的缓存客户端，使后续 ReadFile/WriteFile/
		// Rename 等操作不再反复命中已失效的旧客户端（原先只有重连会话才能恢复）。
		// 旧客户端可能有并发传输在跑，不在此关闭；未能替换时才关闭临时客户端。
		if !s.sshSvc.AdoptSFTPClient(sessionID, client, retryClient) {
			_ = retryClient.Close()
		}
	}

	entries := make([]FileEntry, 0, len(infos))
	for _, info := range infos {
		// 文件名参与前端拼接与后续下载路径：拒绝异常/恶意服务端返回的
		// 含分隔符条目，避免下钻或下载时写到目录之外
		if !isSafeEntryName(info.Name()) {
			continue
		}
		mode := info.Mode()
		entries = append(entries, FileEntry{
			Name:      info.Name(),
			Size:      info.Size(),
			Mode:      mode.String(), // 形如 "drwxr-xr-x"
			ModTime:   info.ModTime().Format(time.RFC3339),
			IsDir:     info.IsDir(),
			IsSymlink: mode&os.ModeSymlink != 0,
		})
	}
	return entries, nil
}

// isSafeEntryName 判断远端返回的条目名能否直接参与路径拼接。
//
// POSIX 与 Windows 的单个文件名都不允许包含路径分隔符；出现 "/"、"\"
// 或本身是 "."/".." 的条目只可能来自异常或恶意 SFTP 服务端。若放行，
// filepath.Join 会把下载目标解到用户选定目录之外（服务端可控文件名 →
// 本地任意路径写入），打包下载的 ZIP 也会带上 "../" 成员。
func isSafeEntryName(name string) bool {
	if name == "" || name == "." || name == ".." {
		return false
	}
	if strings.ContainsAny(name, "/\\") || strings.IndexByte(name, 0) >= 0 {
		return false
	}
	return true
}

// ReadFile 读取远程小文件内容并以字符串返回，用于文本预览。
// 为避免内存溢出，限制最大读取 maxReadFileSize（1MB）字节；超出则返回错误。
func (s *SftpService) ReadFile(sessionID string, path string) (string, error) {
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		return "", err
	}

	// 先检查文件类型，避免对目录/设备文件执行读取操作
	info, err := client.Stat(path)
	if err != nil {
		return "", fmt.Errorf("获取文件信息 %q 失败: %w", path, err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%q 是目录，无法预览", path)
	}
	// 拒绝非常规文件（设备文件、管道、套接字等），避免 SFTP 读取返回 SSH_FX_BAD_MESSAGE
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%q 不是常规文件，无法预览", path)
	}

	file, err := client.Open(path)
	if err != nil {
		return "", fmt.Errorf("打开文件 %q 失败: %w", path, err)
	}
	defer file.Close()

	// 最多读取 maxReadFileSize+1 字节，若实际读到的超过 maxReadFileSize 则判定文件过大
	limited := io.LimitReader(file, maxReadFileSize+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return "", fmt.Errorf("读取文件 %q 失败: %w", path, err)
	}
	if int64(len(data)) > maxReadFileSize {
		return "", fmt.Errorf("文件 %q 超过 %d 字节限制，请使用下载功能", path, maxReadFileSize)
	}

	return string(data), nil
}

// ReadFileTail 读取远程常规文件末尾最多 maxBytes 字节，用于 shell 历史这类
// 可能超过 ReadFile 上限的大文件。maxBytes 会被限制在 [4KB, 8MB]。
// 截断位置落在行中间时丢弃第一行残片，保证返回内容从完整行开始。
func (s *SftpService) ReadFileTail(sessionID string, path string, maxBytes int64) (string, error) {
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		return "", err
	}

	info, err := client.Stat(path)
	if err != nil {
		return "", fmt.Errorf("获取文件信息 %q 失败: %w", path, err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("%q 是目录，无法读取", path)
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("%q 不是常规文件，无法读取", path)
	}

	offset, length := tailWindow(info.Size(), maxBytes)
	if length == 0 {
		return "", nil
	}
	file, err := client.Open(path)
	if err != nil {
		return "", fmt.Errorf("打开文件 %q 失败: %w", path, err)
	}
	defer file.Close()

	buf := make([]byte, length)
	n, err := file.ReadAt(buf, offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("读取文件 %q 失败: %w", path, err)
	}
	text := string(buf[:n])
	// 从文件中段开始读取时，第一行通常是被截断的半个命令行，丢弃它
	if offset > 0 {
		if idx := strings.IndexByte(text, '\n'); idx >= 0 {
			text = text[idx+1:]
		} else {
			text = ""
		}
	}
	return text, nil
}

// tailWindow 计算读取文件末尾时的起始偏移与长度。
// maxBytes 会被限制在 [minTailBytes, maxTailBytes] 区间内。
func tailWindow(size int64, maxBytes int64) (offset int64, length int64) {
	if maxBytes < minTailBytes {
		maxBytes = minTailBytes
	}
	if maxBytes > maxTailBytes {
		maxBytes = maxTailBytes
	}
	if size <= 0 {
		return 0, 0
	}
	if size <= maxBytes {
		return 0, size
	}
	return size - maxBytes, maxBytes
}

// WriteFile 将文本内容写入远程文件（覆盖写入），用于远程文件编辑保存。
// 保留原文件权限；写入失败时不影响原文件内容（先写临时文件再重命名）。
func (s *SftpService) WriteFile(sessionID string, path string, content string) error {
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		return err
	}

	// 只允许覆盖已存在的常规文件：Stat 失败不能简单视为“新文件”而继续，
	// 否则权限/连接错误、悬空符号链接等异常都会退化为静默覆盖或丢失原权限。
	// 用 Lstat 而非 Stat：读取内容会跟随软链接，但最终 renameOver 替换的是
	// 链接本身。若按 Stat 放行，保存一个 ~/.bashrc -> ~/dotfiles/bashrc 的链接
	// 会把链接变成普通文件，目标仓库里的真实文件反而没有更新。
	info, err := client.Lstat(path)
	if err != nil {
		return fmt.Errorf("获取文件信息 %q 失败: %w", path, err)
	}
	if info.IsDir() {
		return fmt.Errorf("%q 是目录，无法写入", path)
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%q 不是常规文件，无法写入", path)
	}
	origMode := info.Mode().Perm()

	// 写入临时文件再重命名，确保写入失败时原文件内容不丢失。
	// 后缀随机：固定名称在共享可写目录（如 /tmp）中可被他人预先放置为指向
	// 敏感文件的符号链接，保存时会把内容写进链接目标并改写其权限。
	var suffix [6]byte
	_, _ = rand.Read(suffix[:])
	tmpPath := fmt.Sprintf("%s.terminator-tmp-%x", path, suffix)
	file, err := client.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("创建临时文件 %q 失败: %w", tmpPath, err)
	}

	written, writeErr := file.Write([]byte(content))
	if writeErr == nil && written != len(content) {
		writeErr = io.ErrShortWrite
	}
	// SFTP 的写入失败可能在 Close 时才由服务端返回（如磁盘配额不足、连接中断）。
	// 只检查 Write 会漏掉这类错误，进而把截断的临时文件重命名成目标文件，
	// 静默覆盖掉原本完好的远程文件。
	if closeErr := file.Close(); writeErr == nil {
		writeErr = closeErr
	}
	if writeErr != nil {
		_ = client.Remove(tmpPath) // 清理临时文件
		return fmt.Errorf("写入文件 %q 失败: %w", path, writeErr)
	}

	// 恢复原文件权限。Create 创建的临时文件权限由服务端 umask 决定（通常 0644），
	// 若原文件是 0600 等受限权限，Chmod 失败后继续重命名会让文件变成更宽松的权限。
	// 因此权限确实被放宽时必须视为写入失败。
	if err := chmodForOverwrite(client, tmpPath, origMode); err != nil {
		_ = client.Remove(tmpPath)
		return fmt.Errorf("写入文件 %q 失败: %w", path, err)
	}

	// 原子重命名（PosixRename 优先，回退到普通 Rename）
	if err := renameOver(client, tmpPath, path); err != nil {
		_ = client.Remove(tmpPath)
		return fmt.Errorf("写入文件 %q 失败: %w", path, err)
	}
	return nil
}

// WriteLocalFileToRemote 用一个本地文件的完整内容覆盖远端文件（供外部编辑器保存回传）。
//
// 与 Upload 不同：这里不需要进度事件与断点续传，但依然先写临时文件再原子重命名，
// 保证保存过程中远端不会出现半截文件；写入后恢复原文件权限。
// 只允许覆盖已存在的常规文件，避免误写目录或特殊文件。
func (s *SftpService) WriteLocalFileToRemote(sessionID string, localPath string, remotePath string) error {
	info, err := os.Stat(localPath)
	if err != nil {
		return fmt.Errorf("读取本地文件 %q 失败: %w", localPath, err)
	}
	if info.IsDir() {
		return fmt.Errorf("%q 是目录，无法写回远端", localPath)
	}
	src, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("打开本地文件 %q 失败: %w", localPath, err)
	}
	defer src.Close()

	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		return err
	}
	// 用 Lstat 而非 Stat：Stat 会跟随软链接，随后 renameOver 会把链接本身
	// 替换成普通文件，等于悄悄破坏了用户的软链接。这里直接拒绝软链接。
	remoteInfo, err := client.Lstat(remotePath)
	if err != nil {
		return fmt.Errorf("获取远端文件 %q 信息失败: %w", remotePath, err)
	}
	if remoteInfo.IsDir() || !remoteInfo.Mode().IsRegular() {
		return fmt.Errorf("%q 不是常规文件，无法写入", remotePath)
	}

	var suffix [6]byte
	_, _ = rand.Read(suffix[:])
	tmpPath := fmt.Sprintf("%s.terminator-tmp-%x", remotePath, suffix)
	dst, err := client.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("创建临时文件 %q 失败: %w", tmpPath, err)
	}
	_, copyErr := io.Copy(dst, src)
	// 写入失败同样可能在 Close 时才由服务端返回（配额不足、连接中断）
	if closeErr := dst.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		_ = client.Remove(tmpPath)
		return fmt.Errorf("写入远端文件 %q 失败: %w", remotePath, copyErr)
	}
	if err := chmodForOverwrite(client, tmpPath, remoteInfo.Mode().Perm()); err != nil {
		_ = client.Remove(tmpPath)
		return fmt.Errorf("写入远端文件 %q 失败: %w", remotePath, err)
	}
	if err := renameOver(client, tmpPath, remotePath); err != nil {
		_ = client.Remove(tmpPath)
		return err
	}
	return nil
}

// Mkdir 在远程创建单个目录。父目录必须已存在。
func (s *SftpService) Mkdir(sessionID string, path string) error {
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		return err
	}

	if err := client.Mkdir(path); err != nil {
		return fmt.Errorf("创建目录 %q 失败: %w", path, err)
	}
	return nil
}

// Remove 删除远程文件或空目录。
// 通过 Lstat 判断类型后分别调用 Remove（文件）或 RemoveDirectory（空目录）。
// 不能使用 Stat：它会跟随软链接，把"指向目录的链接"当成目录调用 rmdir，
// 多数服务端返回 ENOTDIR，导致该链接永远删不掉。
func (s *SftpService) Remove(sessionID string, path string) error {
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		return err
	}

	info, err := client.Lstat(path)
	if err != nil {
		return fmt.Errorf("获取 %q 信息失败: %w", path, err)
	}

	if info.IsDir() {
		if err := client.RemoveDirectory(path); err != nil {
			return fmt.Errorf("删除目录 %q 失败: %w", path, err)
		}
	} else {
		if err := client.Remove(path); err != nil {
			return fmt.Errorf("删除文件 %q 失败: %w", path, err)
		}
	}
	return nil
}

// Exists 判断远程路径是否已存在，供上传前做同名冲突确认。
// "不存在"必须与"检查失败"区分开：前者说明可以安全上传，后者要继续上报，
// 否则一个网络抖动会被当成"文件不存在"从而静默覆盖已有文件。
func (s *SftpService) Exists(sessionID string, path string) (bool, error) {
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		return false, err
	}

	if _, err := client.Stat(path); err != nil {
		// pkg/sftp 会把 SSH_FX_NO_SUCH_FILE 归一化成 os.ErrNotExist
		if errors.Is(err, os.ErrNotExist) || os.IsNotExist(err) {
			return false, nil
		}
		// 个别服务端用自由文本返回，兜底做一次小写匹配
		lower := strings.ToLower(err.Error())
		if strings.Contains(lower, "no such file") || strings.Contains(lower, "does not exist") {
			return false, nil
		}
		return false, fmt.Errorf("检查 %q 是否存在失败: %w", path, err)
	}
	return true, nil
}

// LocalExistingPaths 返回 localPaths 中已存在于本机的子集，供下载前确认覆盖。
//
// 一次调用完成批量检查：批量下载可能选中上百个条目，逐个发起 IPC 调用代价过高。
// 检查失败（权限不足等）按"不存在"处理，不在下载前阻塞用户：
// 真正的写入错误会由传输队列如实上报。
func (s *SftpService) LocalExistingPaths(localPaths []string) []string {
	existing := make([]string, 0, len(localPaths))
	for _, p := range localPaths {
		if p == "" {
			continue
		}
		if _, err := os.Stat(p); err == nil {
			existing = append(existing, p)
		}
	}
	return existing
}

// Rename 重命名或移动远程文件/目录。
// 优先使用 PosixRename（原子操作），不支持时回退到普通 Rename。
func (s *SftpService) Rename(sessionID string, oldPath string, newPath string) error {
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		return err
	}

	// PosixRename 是 POSIX 语义的原子重命名，目标存在时会被覆盖；
	// 部分服务器不支持该扩展，回退到标准 Rename。
	return renameOver(client, oldPath, newPath)
}

// Chmod 修改远程文件/目录的权限位。
// mode 为标准的 os.FileMode 权限位（如 0755），传入时为 uint32。
func (s *SftpService) Chmod(sessionID string, path string, mode uint32) error {
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		return err
	}

	// 屏蔽高位类型位，保留权限位 + setuid/setgid/sticky（0o7777）
	if err := client.Chmod(path, os.FileMode(mode&0o7777)); err != nil {
		return fmt.Errorf("修改 %q 权限失败: %w", path, err)
	}
	return nil
}

// HomeDir 返回远程用户的家目录。
// SFTP 登录后当前工作目录通常即家目录，Getwd 即可获取。
func (s *SftpService) HomeDir(sessionID string) (string, error) {
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		return "", err
	}

	dir, err := client.Getwd()
	if err != nil {
		// Getwd 失败时回退到 /，避免面板无法打开
		return "/", nil
	}
	return dir, nil
}

// SearchResultEntry 描述搜索结果中的一个条目，包含完整路径。
type SearchResultEntry struct {
	Path  string `json:"path"`  // 完整路径
	Name  string `json:"name"`  // 文件名（不含路径）
	Size  int64  `json:"size"`  // 字节数
	IsDir bool   `json:"isDir"` // 是否为目录
}

// SearchFiles 递归搜索远程文件系统中的文件/目录。
// searchPath 为搜索起始目录，query 为搜索关键词（匹配文件名）。
// maxResults 限制返回结果数量，0 表示使用默认值 200。
// 使用 find 命令实现，比递归 SFTP ListDir 快数十倍。
func (s *SftpService) SearchFiles(sessionID string, searchPath string, query string, maxResults int) ([]SearchResultEntry, error) {
	// 搜索结果上限：maxResults 来自前端绑定调用，不设上限时传入超大值会让
	// find 遍历整个文件系统并把全部结果留在内存与服务端输出缓冲中，
	// 造成长时间占用与内存膨胀。界面固定使用 200，此上限不影响正常使用。
	const maxSearchResults = 1000
	if maxResults <= 0 {
		maxResults = 200
	}
	if maxResults > maxSearchResults {
		maxResults = maxSearchResults
	}

	// 过滤换行符（防止 find -iname 模式包含换行导致静默无结果）
	query = strings.ReplaceAll(query, "\n", "")
	query = strings.ReplaceAll(query, "\r", "")
	searchPath = strings.ReplaceAll(searchPath, "\n", "")
	searchPath = strings.ReplaceAll(searchPath, "\r", "")

	// 转义 find glob 元字符（* ? [ ] \），使 -iname 按字面量匹配
	globEscapedQuery := strings.NewReplacer("\\", "\\\\", "*", "\\*", "?", "\\?", "[", "\\[", "]", "\\]").Replace(query)

	// 对用户输入进行 shell 单引号转义，防止命令注入
	escapedQuery := strings.ReplaceAll(globEscapedQuery, "'", "'\\''")
	escapedPath := strings.ReplaceAll(searchPath, "'", "'\\''")

	// 使用 find 命令递归搜索：
	// -maxdepth 10 限制递归深度避免无限遍历
	// -iname 匹配文件名（大小写不敏感）
	// -print 输出完整路径
	// 2>/dev/null 静默权限错误
	// head -n N 限制结果数量（注意：正数 N 表示前 N 行）
	cmd := fmt.Sprintf("find '%s' -maxdepth 10 -iname '*%s*' -print 2>/dev/null | head -n %d",
		escapedPath, escapedQuery, maxResults)

	output, err := s.sshSvc.ExecCommand(sessionID, cmd, 30*time.Second)
	if err != nil && output == "" {
		return nil, fmt.Errorf("搜索文件失败: %w", err)
	}

	// 解析 find 输出：每行一个完整路径
	lines := strings.Split(strings.TrimSpace(output), "\n")
	results := make([]SearchResultEntry, 0, len(lines))

	// 获取 SFTP 客户端用于查询文件信息（大小、类型）
	client, clientErr := s.sshSvc.GetSFTPClient(sessionID)

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		// 提取文件名
		name := line
		if idx := strings.LastIndex(line, "/"); idx >= 0 && idx < len(line)-1 {
			name = line[idx+1:]
		}
		// find 输出来自服务端，同样不可信：跳过含分隔符或 ".." 的结果，
		// 避免前端把异常名字拼进下载路径
		if !isSafeEntryName(name) {
			continue
		}

		entry := SearchResultEntry{
			Path: line,
			Name: name,
		}

		// 尝试获取文件信息
		if clientErr == nil {
			if info, err := client.Stat(line); err == nil {
				entry.Size = info.Size()
				entry.IsDir = info.IsDir()
			}
		}

		results = append(results, entry)
	}

	return results, nil
}

// Upload 上传本地文件或目录到 remotePath。
// 目标是目录时递归上传：remotePath 即为目标目录本身（不存在时自动创建），
// 内部目录结构按本地相对路径还原；符号链接会被跳过，避免目录环或把
// 目录外的内容传到服务器。
func (s *SftpService) Upload(sessionID string, transferID string, localPath string, remotePath string) error {
	ctx, done, err := s.registerTransfer(transferID)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}
	defer done()

	info, err := os.Stat(localPath)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("读取本地路径失败: %v", err))
		return fmt.Errorf("读取本地路径 %q 失败: %w", localPath, err)
	}
	if !info.IsDir() {
		return s.uploadFile(ctx, sessionID, transferID, localPath, remotePath)
	}
	return s.uploadDir(ctx, sessionID, transferID, localPath, remotePath)
}

// UploadFile 将本地文件上传到远程路径。
// 该方法是同步的（Wails 绑定调用），但会通过 emitter 持续推送传输进度，
// 前端可据 transferID 关联进度事件。传输结束（无论成功失败）推送完成事件。
//
// 支持断点续传：数据先写入
// "<remotePath>.terminator-part-<总字节数>-<源文件修改时间与传输ID摘要>"，
// 中断时该文件保留，同一传输重试时按已有大小从断点继续；全部写完后才原子
// 重命名到 remotePath，因此目标路径不会出现半截文件。
// 源文件大小/修改时间变化或换成另一次传输时会使用新的临时文件，从 0 开始，
// 避免把两次不同来源的数据拼接成一个"成功"的损坏文件。
// 注意"失败后重建传输"（前端会生成新传输 ID）不会复用旧断点。
func (s *SftpService) UploadFile(sessionID string, transferID string, localPath string, remotePath string) error {
	ctx, done, err := s.registerTransfer(transferID)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}
	defer done()
	return s.uploadFile(ctx, sessionID, transferID, localPath, remotePath)
}

// uploadFile 是 UploadFile 的实际实现，接收取消上下文。
func (s *SftpService) uploadFile(ctx context.Context, sessionID string, transferID string, localPath string, remotePath string) error {
	info, err := os.Stat(localPath)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("打开本地文件失败: %v", err))
		return fmt.Errorf("打开本地文件 %q 失败: %w", localPath, err)
	}
	if info.IsDir() {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, "不能上传目录")
		return fmt.Errorf("%q 是目录，请使用 Upload 递归上传", localPath)
	}

	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}

	if err := s.uploadOne(
		ctx, client, sessionID, transferID,
		localPath, remotePath, filepath.Base(localPath),
		info.Size(), 0,
	); err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return fmt.Errorf("上传 %q -> %q 失败: %w", localPath, remotePath, err)
	}

	s.emitter.EmitTransferComplete(sessionID, transferID, true, "")
	return nil
}

// uploadOne 上传单个文件，不发送完成事件（由调用方决定整体成功/失败）。
// progressTotal / progressBase 用于把单文件进度并入目录上传的整体进度：
// 单文件上传传 base=0、total=文件大小；目录上传传所有文件总大小与已完成字节数。
func (s *SftpService) uploadOne(
	ctx context.Context,
	client *sftp.Client,
	sessionID string,
	transferID string,
	localPath string,
	remotePath string,
	displayName string,
	progressTotal int64,
	progressBase int64,
) error {
	localFile, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("打开本地文件 %q 失败: %w", localPath, err)
	}
	defer localFile.Close()

	info, err := localFile.Stat()
	if err != nil {
		return fmt.Errorf("获取本地文件 %q 信息失败: %w", localPath, err)
	}
	if info.IsDir() {
		return fmt.Errorf("%q 是目录，无法上传", localPath)
	}
	total := info.Size()

	part := partPath(remotePath, total, transferIdentity(info.ModTime(), transferID))
	remoteFile, offset, err := openRemoteForResume(client, part, total)
	if err != nil {
		return fmt.Errorf("创建远程文件 %q 失败: %w", part, err)
	}

	// 续传时把本地读取位置对齐到断点
	if offset > 0 {
		if _, err := localFile.Seek(offset, io.SeekStart); err != nil {
			remoteFile.Close()
			return fmt.Errorf("定位本地文件 %q 到 %d 失败: %w", localPath, offset, err)
		}
	}

	copied, err := s.copyWithProgress(
		ctx,
		localFile, remoteFile,
		sessionID, transferID, displayName,
		progressTotal, progressBase+offset,
	)
	if err != nil {
		remoteFile.Close()
		// 保留 part 文件：下次重试可据此续传，不再删除已传数据
		return err
	}
	if copied < total-offset {
		// 源文件在传输期间被截短/替换：已写入的数据不足，不能当作完整文件重命名。
		// 保留 part 文件，下次重试会按新的断点继续（源文件身份已变化时从头开始）。
		_ = remoteFile.Close()
		return fmt.Errorf("上传 %q 不完整：已传 %d 字节，期望 %d 字节（源文件可能在传输期间被修改）", localPath, offset+copied, total)
	}
	if err := remoteFile.Close(); err != nil {
		return fmt.Errorf("关闭远程文件失败: %w", err)
	}

	// 全部写完才落到目标路径，保证目标文件要么是旧内容要么是完整新内容
	if err := renameOver(client, part, remotePath); err != nil {
		_ = client.Remove(part)
		return err
	}
	return nil
}

// uploadDir 递归上传本地目录。
// 先遍历一遍收集目录与文件清单并统计总字节数，再把整体进度推给前端
// （而不是每传一个文件就从 0% 重新开始）。
func (s *SftpService) uploadDir(ctx context.Context, sessionID string, transferID string, localPath string, remotePath string) error {
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}

	type fileItem struct {
		LocalPath  string
		RemotePath string
		Name       string
		Size       int64
	}
	var (
		dirs       []string
		files      []fileItem
		totalBytes int64
	)

	// 根路径本身是符号链接时必须先解析：Upload 用 os.Stat 判定它是目录，
	// 而 filepath.Walk 使用 Lstat 不跟随链接，只会看到链接自身并按"跳过符号
	// 链接"规则丢弃，最终"上传成功"却一个文件也没传。遍历内部的符号链接
	// 仍然跳过，避免目录环与把目录外内容带上去。
	root := localPath
	if fi, lerr := os.Lstat(localPath); lerr == nil && fi.Mode()&os.ModeSymlink != 0 {
		resolved, rerr := filepath.EvalSymlinks(localPath)
		if rerr != nil {
			s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("解析目录链接失败: %v", rerr))
			return fmt.Errorf("解析目录链接 %q 失败: %w", localPath, rerr)
		}
		root = resolved
	}

	walkErr := filepath.Walk(root, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		remote := remotePath
		if rel != "." {
			remote = path.Join(remotePath, filepath.ToSlash(rel))
		}
		// 跳过符号链接：目录链接可能指向自身造成无限递归，
		// 文件链接则会把目录之外的内容一并上传。
		if fi.Mode()&os.ModeSymlink != 0 {
			return nil
		}
		if fi.IsDir() {
			dirs = append(dirs, remote)
			return nil
		}
		// 只上传常规文件：FIFO/套接字/设备文件用 os.Open 读取会永久阻塞
		//（FIFO 等待写入方，且 ctx 取消无法打断阻塞中的 open），
		// 让整个目录上传卡死且用户无法取消。
		if !fi.Mode().IsRegular() {
			return nil
		}
		files = append(files, fileItem{
			LocalPath:  p,
			RemotePath: remote,
			Name:       filepath.Base(p),
			Size:       fi.Size(),
		})
		totalBytes += fi.Size()
		return nil
	})
	if walkErr != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, walkErr.Error())
		return fmt.Errorf("遍历本地目录 %q 失败: %w", localPath, walkErr)
	}

	for _, dir := range dirs {
		if err := client.MkdirAll(dir); err != nil {
			s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("创建远程目录失败: %v", err))
			return fmt.Errorf("创建远程目录 %q 失败: %w", dir, err)
		}
	}

	var done int64
	for _, f := range files {
		if err := checkCanceled(ctx); err != nil {
			s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
			return err
		}
		if err := s.uploadOne(
			ctx, client, sessionID, transferID,
			f.LocalPath, f.RemotePath, f.Name,
			totalBytes, done,
		); err != nil {
			s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
			return fmt.Errorf("上传 %q -> %q 失败: %w", f.LocalPath, f.RemotePath, err)
		}
		done += f.Size
	}

	s.emitter.EmitTransferComplete(sessionID, transferID, true, "")
	return nil
}

// Download 下载远程文件或目录到本地路径。
// 目标是目录时递归下载：localPath 即为目标目录本身（不存在时自动创建）。
func (s *SftpService) Download(sessionID string, transferID string, remotePath string, localPath string) error {
	ctx, done, err := s.registerTransfer(transferID)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}
	defer done()

	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}
	info, err := client.Stat(remotePath)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("读取远程路径失败: %v", err))
		return fmt.Errorf("读取远程路径 %q 失败: %w", remotePath, err)
	}
	if !info.IsDir() {
		return s.downloadFile(ctx, sessionID, transferID, remotePath, localPath)
	}
	return s.downloadDir(ctx, client, sessionID, transferID, remotePath, localPath)
}

// DownloadFile 将远程文件下载到本地路径。
// 与 UploadFile 对称：分块复制并推送进度，同样写入带源端身份的
// ".terminator-part-*" 临时文件以支持断点续传，完成后原子重命名到 localPath。
func (s *SftpService) DownloadFile(sessionID string, transferID string, remotePath string, localPath string) error {
	ctx, done, err := s.registerTransfer(transferID)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}
	defer done()
	return s.downloadFile(ctx, sessionID, transferID, remotePath, localPath)
}

// downloadFile 是 DownloadFile 的实际实现，接收取消上下文。
func (s *SftpService) downloadFile(ctx context.Context, sessionID string, transferID string, remotePath string, localPath string) error {
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}

	info, err := client.Stat(remotePath)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("获取远程文件信息失败: %v", err))
		return fmt.Errorf("获取远程文件 %q 信息失败: %w", remotePath, err)
	}
	if info.IsDir() {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, "不能下载目录")
		return fmt.Errorf("%q 是目录，请使用 Download 递归下载", remotePath)
	}

	if err := s.downloadOne(
		ctx, client, sessionID, transferID,
		remotePath, localPath, filepath.Base(remotePath),
		info.Size(), 0,
	); err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return fmt.Errorf("下载 %q -> %q 失败: %w", remotePath, localPath, err)
	}

	s.emitter.EmitTransferComplete(sessionID, transferID, true, "")
	return nil
}

// downloadOne 下载单个文件，不发送完成事件（由调用方决定整体成功/失败）。
// progressTotal / progressBase 语义同 uploadOne。
func (s *SftpService) downloadOne(
	ctx context.Context,
	client *sftp.Client,
	sessionID string,
	transferID string,
	remotePath string,
	localPath string,
	displayName string,
	progressTotal int64,
	progressBase int64,
) error {
	remoteFile, err := client.Open(remotePath)
	if err != nil {
		return fmt.Errorf("打开远程文件 %q 失败: %w", remotePath, err)
	}
	defer remoteFile.Close()

	info, err := remoteFile.Stat()
	if err != nil {
		return fmt.Errorf("获取远程文件 %q 信息失败: %w", remotePath, err)
	}
	// 拒绝目录下载，避免读取目录句柄产生垃圾数据
	if info.IsDir() {
		return fmt.Errorf("%q 是目录，无法下载", remotePath)
	}
	total := info.Size()

	part := partPath(localPath, total, transferIdentity(info.ModTime(), transferID))
	offset := localResumeOffset(part, total)
	flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	if offset > 0 {
		flags = os.O_WRONLY | os.O_CREATE | os.O_APPEND
	}
	localFile, err := os.OpenFile(part, flags, 0o644)
	if err != nil {
		return fmt.Errorf("创建本地文件 %q 失败: %w", part, err)
	}

	// 续传时把远程读取位置对齐到断点
	if offset > 0 {
		if _, err := remoteFile.Seek(offset, io.SeekStart); err != nil {
			localFile.Close()
			return fmt.Errorf("定位远程文件 %q 到 %d 失败: %w", remotePath, offset, err)
		}
	}

	copied, err := s.copyWithProgress(
		ctx,
		remoteFile, localFile,
		sessionID, transferID, displayName,
		progressTotal, progressBase+offset,
	)
	if err != nil {
		localFile.Close()
		// 保留 part 文件：下次重试可据此续传
		return err
	}
	if copied < total-offset {
		// 远端文件在传输期间被截短（如日志轮转）：本地 part 只是残片，
		// 不能重命名为"完整下载"。保留 part，下次重试按新大小重新判断。
		_ = localFile.Close()
		return fmt.Errorf("下载 %q 不完整：已传 %d 字节，期望 %d 字节（远端文件可能在传输期间被修改）", remotePath, offset+copied, total)
	}
	if err := localFile.Close(); err != nil {
		return fmt.Errorf("关闭文件失败: %w", err)
	}

	if err := os.Rename(part, localPath); err != nil {
		_ = os.Remove(part)
		return err
	}
	return nil
}

// downloadDir 递归下载远程目录。
// 与上传对称：先遍历统计总字节数，再逐个下载并汇总进度。
func (s *SftpService) downloadDir(ctx context.Context, client *sftp.Client, sessionID string, transferID string, remotePath string, localPath string) error {
	type fileItem struct {
		RemotePath string
		LocalPath  string
		Name       string
		Size       int64
	}
	var (
		dirs       []string
		files      []fileItem
		totalBytes int64
	)

	var walk func(remoteDir string, localDir string) error
	walk = func(remoteDir string, localDir string) error {
		entries, err := client.ReadDir(remoteDir)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			// 服务端返回的文件名不可信：含分隔符/.. 的条目会让本地路径逃出
			// 用户选定目录，直接跳过（正常文件系统不可能产生这种名字）
			if !isSafeEntryName(entry.Name()) {
				continue
			}
			remote := path.Join(remoteDir, entry.Name())
			local := filepath.Join(localDir, entry.Name())
			// 跳过符号链接：可能指向目录自身导致无限递归，也可能指向
			// 目标目录之外的位置（下载到本地后失去原有链接语义）。
			if entry.Mode()&os.ModeSymlink != 0 {
				continue
			}
			if entry.IsDir() {
				dirs = append(dirs, local)
				if err := walk(remote, local); err != nil {
					return err
				}
				continue
			}
			files = append(files, fileItem{
				RemotePath: remote,
				LocalPath:  local,
				Name:       entry.Name(),
				Size:       entry.Size(),
			})
			totalBytes += entry.Size()
		}
		return nil
	}

	if err := walk(remotePath, localPath); err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return fmt.Errorf("遍历远程目录 %q 失败: %w", remotePath, err)
	}

	// 根目录与各层子目录先建好，避免文件写入时父目录不存在
	if err := os.MkdirAll(localPath, 0o755); err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("创建本地目录失败: %v", err))
		return fmt.Errorf("创建本地目录 %q 失败: %w", localPath, err)
	}
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("创建本地目录失败: %v", err))
			return fmt.Errorf("创建本地目录 %q 失败: %w", dir, err)
		}
	}

	var done int64
	for _, f := range files {
		// 取消后不再开始下一个文件：目录传输可能包含成千上万个小文件，
		// 只依赖单文件复制循环内的检查会让取消延迟到下一个大文件中段。
		if err := checkCanceled(ctx); err != nil {
			s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
			return err
		}
		if err := s.downloadOne(
			ctx, client, sessionID, transferID,
			f.RemotePath, f.LocalPath, f.Name,
			totalBytes, done,
		); err != nil {
			s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
			return fmt.Errorf("下载 %q -> %q 失败: %w", f.RemotePath, f.LocalPath, err)
		}
		done += f.Size
	}

	s.emitter.EmitTransferComplete(sessionID, transferID, true, "")
	return nil
}

// copyWithProgress 以 transferChunkSize 为单位从 src 复制到 dst，
// 每 progressEmitInterval 推送一次进度（时间节流，非每块都发）。
// src/dst 必须已打开，total 为本次传输的总字节数，
// initial 为续传时已存在的字节数（从 0 开始传输时传 0）。
//
// 返回本次实际复制的字节数（不含 initial）。调用方必须校验它与
// "源文件总字节数 - 断点偏移"一致：源文件在传输过程中被截短/改写时，
// 少读的部分不会被发现，直接重命名会把半截文件当成完整文件。
func (s *SftpService) copyWithProgress(ctx context.Context, src io.Reader, dst io.Writer, sessionID string, transferID string, filename string, total int64, initial int64) (int64, error) {
	buf := make([]byte, transferChunkSize)
	transferred := initial
	var copied int64
	lastEmit := time.Now()

	// 续传时立即上报断点位置，避免进度条先显示 0% 再跳到断点
	if initial > 0 {
		s.emitter.EmitTransferProgress(sessionID, transferID, filename, transferred, total)
	}

	for {
		// 每块前检查取消信号：单块最大 256KB，取消延迟可控
		if err := checkCanceled(ctx); err != nil {
			return copied, err
		}
		n, readErr := src.Read(buf)
		if n > 0 {
			written, werr := dst.Write(buf[:n])
			if werr != nil {
				return copied, werr
			}
			// 部分写回退保护：循环写入直到全部完成
			for written < n {
				m, werr2 := dst.Write(buf[written:n])
				if werr2 != nil {
					return copied, werr2
				}
				// Writer 返回 0 字节且无错误时循环不会推进，会永久挂起；
				// 按短写处理，交由调用方清理临时文件后重试
				if m <= 0 {
					return copied, io.ErrShortWrite
				}
				written += m
			}
			copied += int64(written)
			transferred += int64(written)
			// 时间节流：距上次发射超过 200ms 才推送，避免高频事件淹没前端
			if now := time.Now(); now.Sub(lastEmit) >= progressEmitInterval {
				s.emitter.EmitTransferProgress(sessionID, transferID, filename, transferred, total)
				lastEmit = now
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				break
			}
			return copied, readErr
		}
	}
	// 发送最终进度，确保前端进度条显示 100% 而非卡在最后一次节流的值
	s.emitter.EmitTransferProgress(sessionID, transferID, filename, transferred, total)
	return copied, nil
}
