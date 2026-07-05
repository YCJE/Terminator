// Package sftp 实现基于现有 SSH 连接的 SFTP 文件管理能力。
// 它复用 SshService 持有的 *ssh.Client，通过 SFTP 子系统提供目录浏览、
// 文件读写、上传下载（带进度事件）等操作，供前端 Wails 绑定直接调用。
package sftp

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

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
)

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
		// SFTP 连接可能已失效，重置后重试一次
		s.sshSvc.ResetSFTPClient(sessionID)
		client, err2 := s.sshSvc.GetSFTPClient(sessionID)
		if err2 != nil {
			return nil, fmt.Errorf("读取目录 %q 失败(原始): %w; 重置SFTP失败: %v", path, err, err2)
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
	if err := client.PosixRename(oldPath, newPath); err != nil {
		if err2 := client.Rename(oldPath, newPath); err2 != nil {
			return fmt.Errorf("重命名 %q -> %q 失败: %w (posix: %v)", oldPath, newPath, err2, err)
		}
	}
	return nil
}

// Chmod 修改远程文件/目录的权限位。
// mode 为标准的 os.FileMode 权限位（如 0755），传入时为 uint32。
func (s *SftpService) Chmod(sessionID string, path string, mode uint32) error {
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		return err
	}

	if err := client.Chmod(path, os.FileMode(mode)); err != nil {
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

// UploadFile 将本地文件上传到远程路径。
// 该方法是同步的（Wails 绑定调用），但会通过 emitter 持续推送传输进度，
// 前端可据 transferID 关联进度事件。传输结束（无论成功失败）推送完成事件。
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
	total := info.Size()

	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}

	// 创建（或截断）远程文件
	remoteFile, err := client.Create(remotePath)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("创建远程文件失败: %v", err))
		return fmt.Errorf("创建远程文件 %q 失败: %w", remotePath, err)
	}
	defer remoteFile.Close()

	if err := s.copyWithProgress(localFile, remoteFile, sessionID, transferID, filename, total); err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return fmt.Errorf("上传 %q -> %q 失败: %w", localPath, remotePath, err)
	}

	s.emitter.EmitTransferComplete(sessionID, transferID, true, "")
	return nil
}

// DownloadFile 将远程文件下载到本地路径。
// 与 UploadFile 对称：打开远程文件、创建本地文件、分块复制并推送进度。
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
	total := info.Size()

	// 创建本地文件
	localFile, err := os.Create(localPath)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, fmt.Sprintf("创建本地文件失败: %v", err))
		return fmt.Errorf("创建本地文件 %q 失败: %w", localPath, err)
	}
	defer localFile.Close()

	if err := s.copyWithProgress(remoteFile, localFile, sessionID, transferID, filename, total); err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		// 传输失败时清理不完整的本地文件
		localFile.Close()
		os.Remove(localPath)
		return fmt.Errorf("下载 %q -> %q 失败: %w", remotePath, localPath, err)
	}

	s.emitter.EmitTransferComplete(sessionID, transferID, true, "")
	return nil
}

// copyWithProgress 以 transferChunkSize 为单位从 src 复制到 dst，
// 每 progressEmitInterval 推送一次进度（时间节流，非每块都发）。
// src/dst 必须已打开，total 为本次传输的总字节数。
func (s *SftpService) copyWithProgress(src io.Reader, dst io.Writer, sessionID string, transferID string, filename string, total int64) error {
	buf := make([]byte, transferChunkSize)
	var transferred int64
	lastEmit := time.Now()

	for {
		n, readErr := src.Read(buf)
		if n > 0 {
			written, werr := dst.Write(buf[:n])
			if werr != nil {
				return werr
			}
			// 部分写回退保护：理论上 dst.Write 应写入全部，但安全起见处理短写
			if written < n {
				// 极少发生；将剩余部分补写，仍失败则报错
				_, werr2 := dst.Write(buf[written:n])
				if werr2 != nil {
					return werr2
				}
				written = n
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
	return nil
}
