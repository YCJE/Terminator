// 跨服务器文件复制（远端 → 远端）。
//
// 数据直接从源服务器的 SFTP 读取流写入目标服务器，既不落本地磁盘也不整体读入内存。
// 目标端沿用单机上传的续传约定：先写带源端身份的 ".terminator-part-*" 临时文件，
// 全部写完才原子重命名到目标路径，因此中断不会留下半截文件，
// 同一传输重试可按已有大小续传。
// 进度事件挂在源会话上（前端传输队列按源会话分组展示）。

package sftp

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	"github.com/pkg/sftp"
)

// crossCopySource 是复制所需的源端只读接口。
// 抽成接口便于在单测里用内存文件系统验证递归、跳过符号链接与断点续传，
// 生产实现直接包装 *sftp.Client。
type crossCopySource interface {
	stat(p string) (os.FileInfo, error)
	readDir(p string) ([]os.FileInfo, error)
	open(p string) (io.ReadSeekCloser, error)
}

type sftpCopySource struct {
	client *sftp.Client
}

func (s sftpCopySource) stat(p string) (os.FileInfo, error) {
	return s.client.Stat(p)
}

func (s sftpCopySource) readDir(p string) ([]os.FileInfo, error) {
	return s.client.ReadDir(p)
}

func (s sftpCopySource) open(p string) (io.ReadSeekCloser, error) {
	return s.client.Open(p)
}

// crossCopyTarget 是复制所需的目标端写接口。
type crossCopyTarget interface {
	stat(p string) (os.FileInfo, error)
	mkdirAll(p string) error
	// openPart 打开续传临时文件：total 用于判定旧断点是否仍然有效。
	// 返回实际生效的起始偏移（服务器不支持追加标志时为 0）。
	openPart(p string, total int64) (io.WriteCloser, int64, error)
	renameOver(from string, to string) error
	remove(p string) error
	chmod(p string, mode os.FileMode) error
}

type sftpCopyTarget struct {
	client *sftp.Client
}

func (t sftpCopyTarget) stat(p string) (os.FileInfo, error) {
	return t.client.Stat(p)
}

func (t sftpCopyTarget) mkdirAll(p string) error {
	return t.client.MkdirAll(p)
}

func (t sftpCopyTarget) openPart(p string, total int64) (io.WriteCloser, int64, error) {
	file, offset, err := openRemoteForResume(t.client, p, remoteResumeOffset(t.client, p, total))
	if err != nil {
		return nil, 0, err
	}
	return file, offset, nil
}

func (t sftpCopyTarget) renameOver(from string, to string) error {
	return renameOver(t.client, from, to)
}

func (t sftpCopyTarget) remove(p string) error {
	return t.client.Remove(p)
}

func (t sftpCopyTarget) chmod(p string, mode os.FileMode) error {
	return t.client.Chmod(p, mode)
}

// crossCopyFile 一条待复制的远端文件（含目标侧完整路径）。
type crossCopyFile struct {
	src     string
	dst     string
	name    string
	size    int64
	mode    os.FileMode
	modTime time.Time
}

// crossCopyPlan 一次目录复制的执行计划。
type crossCopyPlan struct {
	// dirs 目标侧需要创建的目录，首项为复制根目录
	dirs  []string
	files []crossCopyFile
	total int64
}

// planCrossCopy 递归收集源目录下的全部条目并统计总字节数。
// 符号链接一律跳过：跟随可能指向复制目标之外的位置，也可能构成目录环；
// 设备文件、管道等非常规文件同样跳过（SFTP 无法安全地逐字节复制）。
func planCrossCopy(src crossCopySource, srcRoot string, dstRoot string) (*crossCopyPlan, error) {
	plan := &crossCopyPlan{dirs: []string{dstRoot}}
	visited := map[string]struct{}{}

	var walk func(srcDir string, dstDir string) error
	walk = func(srcDir string, dstDir string) error {
		// 目录软链接已被跳过，这里再用访问集合兜底，避免异常服务端返回环状目录
		if _, ok := visited[srcDir]; ok {
			return nil
		}
		visited[srcDir] = struct{}{}

		infos, err := src.readDir(srcDir)
		if err != nil {
			return fmt.Errorf("读取源目录 %q 失败: %w", srcDir, err)
		}
		for _, info := range infos {
			// 源端返回的文件名不可信：含分隔符/.. 的名字会让目标端路径
			// 逃出目标目录（源服务器可控 → 目标服务器任意路径写入）
			if !isSafeEntryName(info.Name()) {
				continue
			}
			childSrc := path.Join(srcDir, info.Name())
			childDst := path.Join(dstDir, info.Name())
			if info.Mode()&os.ModeSymlink != 0 {
				continue
			}
			if info.IsDir() {
				plan.dirs = append(plan.dirs, childDst)
				if err := walk(childSrc, childDst); err != nil {
					return err
				}
				continue
			}
			if !info.Mode().IsRegular() {
				continue
			}
			plan.files = append(plan.files, crossCopyFile{
				src:     childSrc,
				dst:     childDst,
				name:    info.Name(),
				size:    info.Size(),
				mode:    info.Mode().Perm(),
				modTime: info.ModTime(),
			})
			plan.total += info.Size()
		}
		return nil
	}

	if err := walk(srcRoot, dstRoot); err != nil {
		return nil, err
	}
	return plan, nil
}

// copyCrossOne 复制单个文件，进度并入 progressTotal/progressBase 描述的整体进度。
// 不发送完成事件，由调用方决定整体成功或失败。
func (s *SftpService) copyCrossOne(
	ctx context.Context,
	src crossCopySource,
	dst crossCopyTarget,
	sessionID string,
	transferID string,
	srcPath string,
	dstPath string,
	displayName string,
	size int64,
	progressTotal int64,
	progressBase int64,
	mode os.FileMode,
	modTime time.Time,
) error {
	reader, err := src.open(srcPath)
	if err != nil {
		return fmt.Errorf("打开源文件 %q 失败: %w", srcPath, err)
	}
	defer reader.Close()

	if dir := path.Dir(dstPath); dir != "" && dir != "." {
		if err := dst.mkdirAll(dir); err != nil {
			return fmt.Errorf("创建目标目录 %q 失败: %w", dir, err)
		}
	}

	part := partPath(dstPath, size, transferIdentity(modTime, transferID))
	writer, offset, err := dst.openPart(part, size)
	if err != nil {
		return fmt.Errorf("创建目标临时文件 %q 失败: %w", part, err)
	}
	// 续传时把源读取位置对齐到断点
	if offset > 0 {
		if _, err := reader.Seek(offset, io.SeekStart); err != nil {
			_ = writer.Close()
			return fmt.Errorf("定位源文件 %q 到 %d 失败: %w", srcPath, offset, err)
		}
	}

	if err := s.copyWithProgress(
		ctx, reader, writer,
		sessionID, transferID, displayName,
		progressTotal, progressBase+offset,
	); err != nil {
		_ = writer.Close()
		// 保留临时文件：下次重试可据此续传
		return err
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("关闭目标文件 %q 失败: %w", dstPath, err)
	}

	// 全部写完才落到目标路径，保证目标文件要么是旧内容要么是完整新内容
	if err := dst.renameOver(part, dstPath); err != nil {
		_ = dst.remove(part)
		return err
	}
	// 尽力保留源文件权限位：失败只影响权限，不影响内容，不作为复制失败
	if mode != 0 {
		_ = dst.chmod(dstPath, mode.Perm())
	}
	return nil
}

// runCrossCopy 执行一次复制：info 为源路径的 Stat 结果，决定走单文件还是目录递归。
func (s *SftpService) runCrossCopy(
	ctx context.Context,
	src crossCopySource,
	dst crossCopyTarget,
	sessionID string,
	transferID string,
	srcPath string,
	dstPath string,
	info os.FileInfo,
) error {
	displayName := path.Base(srcPath)

	if !info.IsDir() {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("%q 不是常规文件，无法复制", srcPath)
		}
		return s.copyCrossOne(
			ctx, src, dst, sessionID, transferID,
			srcPath, dstPath, displayName,
			info.Size(), info.Size(), 0, info.Mode().Perm(), info.ModTime(),
		)
	}

	plan, err := planCrossCopy(src, srcPath, dstPath)
	if err != nil {
		return err
	}
	for _, dir := range plan.dirs {
		if err := dst.mkdirAll(dir); err != nil {
			return fmt.Errorf("创建目标目录 %q 失败: %w", dir, err)
		}
	}

	var done int64
	for _, file := range plan.files {
		// 目录复制可能含大量小文件，逐文件检查取消，避免取消延迟到下一个大文件中段
		if err := checkCanceled(ctx); err != nil {
			return err
		}
		if err := s.copyCrossOne(
			ctx, src, dst, sessionID, transferID,
			file.src, file.dst, file.name,
			file.size, plan.total, done, file.mode, file.modTime,
		); err != nil {
			return fmt.Errorf("复制 %q -> %q 失败: %w", file.src, file.dst, err)
		}
		done += file.size
	}
	return nil
}

// CopyBetweenSessions 把源会话上的文件/目录复制到目标会话的指定路径。
//
// srcPath 为源端路径；dstPath 为目标端路径：源是文件时为目标文件完整路径
// （父目录自动创建），源是目录时为目标目录根（目录内容按原结构复制进去）。
// transferID 用于进度事件关联与取消；进度事件挂在源会话上。
func (s *SftpService) CopyBetweenSessions(
	srcSessionID string,
	srcPath string,
	dstSessionID string,
	dstPath string,
	transferID string,
) error {
	ctx, done := s.registerTransfer(transferID)
	defer done()

	emitFail := func(err error) error {
		s.emitter.EmitTransferComplete(srcSessionID, transferID, false, err.Error())
		return err
	}

	src := path.Clean(strings.TrimSpace(srcPath))
	dst := path.Clean(strings.TrimSpace(dstPath))
	if strings.TrimSpace(srcPath) == "" || strings.TrimSpace(dstPath) == "" || src == "." || dst == "." {
		return emitFail(errors.New("源路径与目标路径不能为空"))
	}
	if srcSessionID == dstSessionID && src == dst {
		return emitFail(errors.New("源与目标是同一路径"))
	}

	srcClient, err := s.sshSvc.GetSFTPClient(srcSessionID)
	if err != nil {
		return emitFail(err)
	}
	dstClient, err := s.sshSvc.GetSFTPClient(dstSessionID)
	if err != nil {
		return emitFail(err)
	}

	info, err := srcClient.Stat(src)
	if err != nil {
		return emitFail(fmt.Errorf("读取源路径 %q 失败: %w", src, err))
	}

	if err := s.runCrossCopy(
		ctx, sftpCopySource{client: srcClient}, sftpCopyTarget{client: dstClient},
		srcSessionID, transferID, src, dst, info,
	); err != nil {
		return emitFail(fmt.Errorf("跨服务器复制失败: %w", err))
	}

	s.emitter.EmitTransferComplete(srcSessionID, transferID, true, "")
	return nil
}
