// Package sftp 实现基于现有 SSH 连接的 SFTP 文件管理能力。
// 它复用 SshService 持有的 *ssh.Client，通过 SFTP 子系统提供目录浏览、
// 文件读写、上传下载（带进度事件）等操作，供前端 Wails 绑定直接调用。
package sftp

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
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
	// progressEmitInterval 进度事件最小发射间隔，避免高频事件淹没前端
	progressEmitInterval = 200 * time.Millisecond
	// partSuffix 续传临时文件后缀。传输过程始终写入该文件，全部完成后再
	// 原子重命名到目标路径：中断不会留下半截的目标文件，重试时按已有大小续传。
	partSuffix = ".terminator-part"
)

// partPath 返回目标路径对应的续传临时文件路径。
//
// 名称中带上本次传输的总字节数：同一目标路径先后传输内容不同的文件时
// （例如上传到固定的发布路径、或远端文件被替换），旧断点不会与新传输
// 匹配，避免把两次不同来源的数据拼接成内容损坏的文件。
func partPath(path string, total int64) string {
	return fmt.Sprintf("%s%s-%d", path, partSuffix, total)
}

// remoteResumeOffset 探测远程续传起点：临时文件存在且大小严格小于源文件总
// 大小时从该大小继续，否则返回 0 从头开始。大小不小于 total 说明源文件已
// 变化（变短或内容不同），续传会得到错误内容，故从头重来。
func remoteResumeOffset(client *sftp.Client, part string, total int64) int64 {
	info, err := client.Stat(part)
	if err != nil || info.IsDir() {
		return 0
	}
	if size := info.Size(); size > 0 && size < total {
		return size
	}
	return 0
}

// localResumeOffset 是 remoteResumeOffset 的本地版本，语义完全一致。
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
// 回退到标准 Rename。
func renameOver(client *sftp.Client, from string, to string) error {
	if err := client.PosixRename(from, to); err != nil {
		if err2 := client.Rename(from, to); err2 != nil {
			return fmt.Errorf("重命名 %q -> %q 失败: %w (posix: %v)", from, to, err2, err)
		}
	}
	return nil
}

// openRemoteForResume 打开远程临时文件用于写入，返回实际生效的起始偏移。
// offset > 0 时以追加方式打开以从断点继续；少数服务器不支持追加标志，
// 此时回退为截断重建并返回 0，从头重传。
func openRemoteForResume(client *sftp.Client, part string, offset int64) (*sftp.File, int64, error) {
	if offset > 0 {
		if f, err := client.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_APPEND); err == nil {
			return f, offset, nil
		}
	}

	f, err := client.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_TRUNC)
	if err != nil {
		return nil, 0, err
	}
	return f, 0, nil
}

// SftpService 提供 SFTP 文件管理能力，作为 Wails 服务注册。
// 它不持有连接本身，而是通过 SshService 按需获取（懒加载的）SFTP 客户端。
type SftpService struct {
	sshSvc  *ssh.SshService
	emitter SFTPEmitter
}

// NewSftpService 创建 SFTP 文件管理服务。
// sshSvc 用于获取已建立 SSH 连接的 SFTP 客户端；emitter 用于推送传输进度事件。
func NewSftpService(sshSvc *ssh.SshService, emitter SFTPEmitter) *SftpService {
	return &SftpService{
		sshSvc:  sshSvc,
		emitter: emitter,
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
		// 其他 SFTP 错误（如通道临时失效），重置后重试一次
		s.sshSvc.ResetSFTPClient(sessionID)
		client, err2 := s.sshSvc.GetSFTPClient(sessionID)
		if err2 != nil {
			// 会话已不存在，返回原始错误
			return nil, fmt.Errorf("读取目录 %q 失败: %w", path, err)
		}
		infos, err = client.ReadDir(path)
		if err != nil {
			return nil, fmt.Errorf("读取目录 %q 失败(重试后): %w", path, err)
		}
	}

	entries := make([]FileEntry, 0, len(infos))
	for _, info := range infos {
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

// WriteFile 将文本内容写入远程文件（覆盖写入），用于远程文件编辑保存。
// 保留原文件权限；写入失败时不影响原文件内容（先写临时文件再重命名）。
func (s *SftpService) WriteFile(sessionID string, path string, content string) error {
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		return err
	}

	// 检查文件类型，拒绝目录和非常规文件
	var origMode os.FileMode
	info, err := client.Stat(path)
	if err == nil { // 文件已存在时检查类型并记录权限
		if info.IsDir() {
			return fmt.Errorf("%q 是目录，无法写入", path)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("%q 不是常规文件，无法写入", path)
		}
		origMode = info.Mode().Perm()
	}

	// 写入临时文件再重命名，确保写入失败时原文件内容不丢失
	tmpPath := path + ".terminator-tmp"
	file, err := client.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("创建临时文件 %q 失败: %w", tmpPath, err)
	}

	_, writeErr := file.Write([]byte(content))
	_ = file.Close()
	if writeErr != nil {
		_ = client.Remove(tmpPath) // 清理临时文件
		return fmt.Errorf("写入文件 %q 失败: %w", path, writeErr)
	}

	// 恢复原文件权限（如有）
	if origMode != 0 {
		_ = client.Chmod(tmpPath, origMode)
	}

	// 原子重命名（PosixRename 优先，回退到普通 Rename）
	if err := renameOver(client, tmpPath, path); err != nil {
		_ = client.Remove(tmpPath)
		return fmt.Errorf("写入文件 %q 失败: %w", path, err)
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
// 通过 Stat 判断类型后分别调用 Remove（文件）或 RemoveDirectory（空目录）。
func (s *SftpService) Remove(sessionID string, path string) error {
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		return err
	}

	info, err := client.Stat(path)
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
	if maxResults <= 0 {
		maxResults = 200
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

// UploadFile 将本地文件上传到远程路径。
// 该方法是同步的（Wails 绑定调用），但会通过 emitter 持续推送传输进度，
// 前端可据 transferID 关联进度事件。传输结束（无论成功失败）推送完成事件。
//
// 支持断点续传：数据先写入 "<remotePath>.terminator-part-<总字节数>"，中断时该文件保留，
// 重试时按已有大小从断点继续；全部写完后才原子重命名到 remotePath，
// 因此目标路径不会出现半截文件。续传假定源文件在两次尝试之间未改动。
func (s *SftpService) UploadFile(sessionID string, transferID string, localPath string, remotePath string) error {
	filename := filepath.Base(localPath)

	// 打开本地文件
	localFile, err := os.Open(localPath)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("打开本地文件失败: %v", err))
		return fmt.Errorf("打开本地文件 %q 失败: %w", localPath, err)
	}
	defer localFile.Close()

	// 获取本地文件大小作为传输总量
	info, err := localFile.Stat()
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("获取本地文件信息失败: %v", err))
		return fmt.Errorf("获取本地文件 %q 信息失败: %w", localPath, err)
	}
	if info.IsDir() {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, "不能上传目录")
		return fmt.Errorf("%q 是目录，无法上传", localPath)
	}
	total := info.Size()

	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}

	part := partPath(remotePath, total)
	remoteFile, offset, err := openRemoteForResume(client, part, remoteResumeOffset(client, part, total))
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("创建远程文件失败: %v", err))
		return fmt.Errorf("创建远程文件 %q 失败: %w", part, err)
	}

	// 续传时把本地读取位置对齐到断点
	if offset > 0 {
		if _, err := localFile.Seek(offset, io.SeekStart); err != nil {
			remoteFile.Close()
			s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("定位本地文件失败: %v", err))
			return fmt.Errorf("定位本地文件 %q 到 %d 失败: %w", localPath, offset, err)
		}
	}

	if err := s.copyWithProgress(localFile, remoteFile, sessionID, transferID, filename, total, offset); err != nil {
		remoteFile.Close()
		// 保留 part 文件：下次重试可据此续传，不再删除已传数据
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return fmt.Errorf("上传 %q -> %q 失败: %w", localPath, remotePath, err)
	}
	if err := remoteFile.Close(); err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("关闭远程文件失败: %v", err))
		return fmt.Errorf("上传 %q -> %q 关闭远程文件失败: %w", localPath, remotePath, err)
	}

	// 全部写完才落到目标路径，保证目标文件要么是旧内容要么是完整新内容
	if err := renameOver(client, part, remotePath); err != nil {
		_ = client.Remove(part)
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return fmt.Errorf("上传 %q -> %q 失败: %w", localPath, remotePath, err)
	}

	s.emitter.EmitTransferComplete(sessionID, transferID, true, "")
	return nil
}

// DownloadFile 将远程文件下载到本地路径。
// 与 UploadFile 对称：分块复制并推送进度，同样写入 "<localPath>.terminator-part-<总字节数>"
// 以支持断点续传，完成后原子重命名到 localPath。
func (s *SftpService) DownloadFile(sessionID string, transferID string, remotePath string, localPath string) error {
	filename := filepath.Base(remotePath)

	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}

	// 打开远程文件
	remoteFile, err := client.Open(remotePath)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("打开远程文件失败: %v", err))
		return fmt.Errorf("打开远程文件 %q 失败: %w", remotePath, err)
	}
	defer remoteFile.Close()

	// 获取远程文件大小作为传输总量
	info, err := remoteFile.Stat()
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("获取远程文件信息失败: %v", err))
		return fmt.Errorf("获取远程文件 %q 信息失败: %w", remotePath, err)
	}
	// 拒绝目录下载，避免读取目录句柄产生垃圾数据
	if info.IsDir() {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, "不能下载目录")
		return fmt.Errorf("%q 是目录，无法下载", remotePath)
	}
	total := info.Size()

	part := partPath(localPath, total)
	offset := localResumeOffset(part, total)
	flags := os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	if offset > 0 {
		flags = os.O_WRONLY | os.O_CREATE | os.O_APPEND
	}
	localFile, err := os.OpenFile(part, flags, 0o644)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("创建本地文件失败: %v", err))
		return fmt.Errorf("创建本地文件 %q 失败: %w", part, err)
	}

	// 续传时把远程读取位置对齐到断点
	if offset > 0 {
		if _, err := remoteFile.Seek(offset, io.SeekStart); err != nil {
			localFile.Close()
			s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("定位远程文件失败: %v", err))
			return fmt.Errorf("定位远程文件 %q 到 %d 失败: %w", remotePath, offset, err)
		}
	}

	if err := s.copyWithProgress(remoteFile, localFile, sessionID, transferID, filename, total, offset); err != nil {
		localFile.Close()
		// 保留 part 文件：下次重试可据此续传
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return fmt.Errorf("下载 %q -> %q 失败: %w", remotePath, localPath, err)
	}
	if err := localFile.Close(); err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("关闭文件失败: %v", err))
		return fmt.Errorf("下载 %q -> %q 关闭文件失败: %w", remotePath, localPath, err)
	}

	if err := os.Rename(part, localPath); err != nil {
		_ = os.Remove(part)
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("重命名文件失败: %v", err))
		return fmt.Errorf("下载 %q -> %q 失败: %w", remotePath, localPath, err)
	}

	s.emitter.EmitTransferComplete(sessionID, transferID, true, "")
	return nil
}

// copyWithProgress 以 transferChunkSize 为单位从 src 复制到 dst，
// 每 progressEmitInterval 推送一次进度（时间节流，非每块都发）。
// src/dst 必须已打开，total 为本次传输的总字节数，
// initial 为续传时已存在的字节数（从 0 开始传输时传 0）。
func (s *SftpService) copyWithProgress(src io.Reader, dst io.Writer, sessionID string, transferID string, filename string, total int64, initial int64) error {
	buf := make([]byte, transferChunkSize)
	transferred := initial
	lastEmit := time.Now()

	// 续传时立即上报断点位置，避免进度条先显示 0% 再跳到断点
	if initial > 0 {
		s.emitter.EmitTransferProgress(sessionID, transferID, filename, transferred, total)
	}

	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			written, werr := dst.Write(buf[:n])
			if werr != nil {
				return werr
			}
			// 部分写回退保护：循环写入直到全部完成
			for written < n {
				m, werr2 := dst.Write(buf[written:n])
				if werr2 != nil {
					return werr2
				}
				written += m
			}
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
			return readErr
		}
	}
	// 发送最终进度，确保前端进度条显示 100% 而非卡在最后一次节流的值
	s.emitter.EmitTransferProgress(sessionID, transferID, filename, transferred, total)
	return nil
}
