// 远端多条目 ZIP 打包下载。
//
// 与普通下载不同：批量选择多个文件/目录时，逐个下载会产生大量队列条目；
// 这里在本地直接流式写一个 ZIP，进度按"已读取的远端字节"汇总上报，
// 中途失败或取消时删除未完成的临时文件，不会留下半截压缩包。

package sftp

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

// archiveSource 是打包需要的远端只读接口。
// 抽成接口便于在单测里用内存文件系统验证递归、命名与取消逻辑，
// 生产实现直接包装 *sftp.Client。
type archiveSource interface {
	stat(p string) (os.FileInfo, error)
	readDir(p string) ([]os.FileInfo, error)
	open(p string) (io.ReadCloser, error)
}

type sftpArchiveSource struct {
	client *sftp.Client
}

func (s sftpArchiveSource) stat(p string) (os.FileInfo, error) {
	return s.client.Stat(p)
}

func (s sftpArchiveSource) readDir(p string) ([]os.FileInfo, error) {
	return s.client.ReadDir(p)
}

func (s sftpArchiveSource) open(p string) (io.ReadCloser, error) {
	f, err := s.client.Open(p)
	if err != nil {
		return nil, err
	}
	return f, nil
}

type archiveEntry struct {
	remotePath string
	zipName    string
	size       int64
	isDir      bool
	modTime    time.Time
}

// uniqueArchiveName 处理同名顶层的冲突（例如从不同目录多选同名文件），
// 在扩展名前追加 " (2)"、" (3)"，避免 ZIP 内条目互相覆盖。
func uniqueArchiveName(name string, used map[string]struct{}) string {
	if _, ok := used[name]; !ok {
		used[name] = struct{}{}
		return name
	}
	ext := path.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for index := 2; ; index++ {
		candidate := fmt.Sprintf("%s (%d)%s", base, index, ext)
		if _, ok := used[candidate]; !ok {
			used[candidate] = struct{}{}
			return candidate
		}
	}
}

// collectArchiveEntries 递归收集需要写入 ZIP 的条目，并统计总字节数。
// 目录条目会保留（空目录也能还原）；符号链接跳过，避免链接环导致无限递归。
func collectArchiveEntries(src archiveSource, remotePaths []string) ([]archiveEntry, int64, error) {
	used := map[string]struct{}{}
	visited := map[string]struct{}{}
	var entries []archiveEntry
	var total int64

	var walk func(remoteDir string, zipPrefix string) error
	walk = func(remoteDir string, zipPrefix string) error {
		if _, ok := visited[remoteDir]; ok {
			return nil
		}
		visited[remoteDir] = struct{}{}
		infos, err := src.readDir(remoteDir)
		if err != nil {
			return fmt.Errorf("读取远程目录 %q 失败: %w", remoteDir, err)
		}
		for _, info := range infos {
			// 服务端返回的名字不可信：带分隔符的条目写进 ZIP 会变成
			// 解压时的路径穿越成员（zip-slip），直接跳过
			if !isSafeEntryName(info.Name()) {
				continue
			}
			if info.Mode()&os.ModeSymlink != 0 {
				continue
			}
			childRemote := path.Join(remoteDir, info.Name())
			childZip := path.Join(zipPrefix, info.Name())
			if info.IsDir() {
				entries = append(entries, archiveEntry{
					remotePath: childRemote,
					zipName:    childZip,
					isDir:      true,
					modTime:    info.ModTime(),
				})
				if err := walk(childRemote, childZip); err != nil {
					return err
				}
				continue
			}
			entries = append(entries, archiveEntry{
				remotePath: childRemote,
				zipName:    childZip,
				size:       info.Size(),
				modTime:    info.ModTime(),
			})
			total += info.Size()
		}
		return nil
	}

	for _, remotePath := range remotePaths {
		clean := path.Clean(strings.TrimSpace(remotePath))
		if clean == "" || clean == "." {
			continue
		}
		info, err := src.stat(clean)
		if err != nil {
			return nil, 0, fmt.Errorf("读取远程路径 %q 失败: %w", clean, err)
		}
		name := path.Base(clean)
		if !isSafeEntryName(name) {
			// 顶层路径本身是 "/" 或异常形式时给一个稳定的安全名字
			name = "archive-root"
		}
		zipName := uniqueArchiveName(name, used)
		if info.IsDir() {
			entries = append(entries, archiveEntry{
				remotePath: clean,
				zipName:    zipName,
				isDir:      true,
				modTime:    info.ModTime(),
			})
			if err := walk(clean, zipName); err != nil {
				return nil, 0, err
			}
			continue
		}
		entries = append(entries, archiveEntry{
			remotePath: clean,
			zipName:    zipName,
			size:       info.Size(),
			modTime:    info.ModTime(),
		})
		total += info.Size()
	}
	return entries, total, nil
}

// downloadArchive 是打包下载的实际实现。
// 返回前会关闭并删除临时文件；只有成功完成并原子重命名后才保留目标文件。
func (s *SftpService) downloadArchive(
	ctx context.Context,
	src archiveSource,
	sessionID string,
	transferID string,
	localPath string,
	remotePaths []string,
) error {
	entries, total, err := collectArchiveEntries(src, remotePaths)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		return errors.New("没有可打包的文件")
	}

	displayName := filepath.Base(localPath)
	part := localPath + ".terminator-zip-part"
	if err := os.Remove(part); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("清理旧的临时文件 %q 失败: %w", part, err)
	}
	localFile, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("创建临时文件 %q 失败: %w", part, err)
	}
	// 任一失败路径都清理临时文件；成功时先关闭句柄再重命名。
	cleanup := func() {
		_ = localFile.Close()
		_ = os.Remove(part)
	}

	zipWriter := zip.NewWriter(localFile)
	if total > 0 {
		s.emitter.EmitTransferProgress(sessionID, transferID, displayName, 0, total)
	}

	var written int64
	for _, entry := range entries {
		if err := checkCanceled(ctx); err != nil {
			_ = zipWriter.Close()
			cleanup()
			return err
		}

		header := &zip.FileHeader{
			Name:     entry.zipName,
			Method:   zip.Deflate,
			Modified: entry.modTime,
		}
		if entry.isDir {
			header.Name = entry.zipName + "/"
			header.Method = zip.Store
			header.SetMode(os.ModeDir | 0o755)
			if _, err := zipWriter.CreateHeader(header); err != nil {
				_ = zipWriter.Close()
				cleanup()
				return fmt.Errorf("写入目录条目 %q 失败: %w", entry.zipName, err)
			}
			continue
		}

		writer, err := zipWriter.CreateHeader(header)
		if err != nil {
			_ = zipWriter.Close()
			cleanup()
			return fmt.Errorf("写入文件条目 %q 失败: %w", entry.zipName, err)
		}
		source, err := src.open(entry.remotePath)
		if err != nil {
			_ = zipWriter.Close()
			cleanup()
			return fmt.Errorf("打开远程文件 %q 失败: %w", entry.remotePath, err)
		}
		copyErr := s.copyWithProgress(
			ctx, source, writer,
			sessionID, transferID, displayName,
			total, written,
		)
		_ = source.Close()
		if copyErr != nil {
			_ = zipWriter.Close()
			cleanup()
			return copyErr
		}
		// 以扫描阶段的大小推进基准：源文件在打包期间被写入时，
		// 进度可能略有偏差，但不影响归档内容（ZIP 写入自身是完整的）。
		written += entry.size
	}

	if err := zipWriter.Close(); err != nil {
		cleanup()
		return fmt.Errorf("完成 ZIP 写入失败: %w", err)
	}
	if err := localFile.Close(); err != nil {
		_ = os.Remove(part)
		return fmt.Errorf("关闭临时文件失败: %w", err)
	}
	if err := os.Rename(part, localPath); err != nil {
		_ = os.Remove(part)
		return fmt.Errorf("保存压缩包 %q 失败: %w", localPath, err)
	}
	return nil
}

// DownloadArchive 将多个远程文件/目录打包成 ZIP 保存到本地。
// remotePaths 支持混合选择；目录会递归包含，空目录保留。
func (s *SftpService) DownloadArchive(sessionID string, transferID string, remotePaths []string, localPath string) error {
	ctx, done := s.registerTransfer(transferID)
	defer done()

	if len(remotePaths) == 0 {
		err := errors.New("没有可打包的条目")
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}
	if strings.TrimSpace(localPath) == "" {
		err := errors.New("压缩包保存路径不能为空")
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}
	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}

	if err := s.downloadArchive(
		ctx, sftpArchiveSource{client: client},
		sessionID, transferID, localPath, remotePaths,
	); err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return fmt.Errorf("打包下载失败: %w", err)
	}
	s.emitter.EmitTransferComplete(sessionID, transferID, true, "")
	return nil
}
