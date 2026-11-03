// Package fileio 提供面向用户的纯文本文件读写，以及本地目录浏览与基础文件操作。
//
// 文本读写只服务于用户在系统文件对话框中选择的路径：终端缓冲区导出、
// 代码片段导入导出等。目录浏览与新建/重命名/删除用于 SFTP 双栏面板的本地侧；
// 所有写操作都要求绝对路径，并拒绝删除根目录与用户主目录本身。
package fileio

import (
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// maxTextBytes 单次读写的文本上限（32MB）。
// 终端滚动缓冲序列化后可达数十 MB，但超过该上限时更大的文件没有实际
// 使用价值，拒绝可以避免一次误操作把大文件读进内存或写出异常大文件。
const maxTextBytes = 32 << 20

// maxBinaryBytes 单次二进制读写的上限（128MB）。
// 二进制读写服务于 ZMODEM 传输：内容经 base64 编码穿过 IPC，
// 过大的文件会让内存占用与序列化开销失控，因此设置明确上限。
const maxBinaryBytes = 128 << 20

// maxLocalEntries 单次目录列表返回的最大条目数：
// 超大目录（如系统临时目录）一次性回传全部条目会让前端渲染与 IPC 负载失控。
const maxLocalEntries = 5000

// LocalEntry 本地目录中的单个条目。
type LocalEntry struct {
	Name  string `json:"name"`
	Path  string `json:"path"`
	IsDir bool   `json:"isDir"`
	Size  int64  `json:"size"`
	// Modified 修改时间（Unix 毫秒），用于列表展示与排序
	Modified int64 `json:"modified"`
}

// LocalListing 本地目录列表结果。
type LocalListing struct {
	Path string `json:"path"`
	// Parent 上级目录；已到达根目录时为空字符串
	Parent string `json:"parent"`
	// Home 用户主目录，用于"回到主目录"按钮
	Home    string       `json:"home"`
	Entries []LocalEntry `json:"entries"`
	// Truncated 条目数超过上限时为 true
	Truncated bool `json:"truncated"`
}

// TextFileService 供前端导出/导入文本使用。
type TextFileService struct{}

func NewTextFileService() *TextFileService {
	return &TextFileService{}
}

// SaveText 将文本写入用户选定的路径，已存在时覆盖。
// 路径来自系统保存对话框；这里仍做最基本的合法性校验，
// 避免空路径或嵌入 NUL 的路径触发底层异常。
func (s *TextFileService) SaveText(path string, content string) error {
	clean, err := validatePath(path)
	if err != nil {
		return err
	}
	if len(content) > maxTextBytes {
		return fmt.Errorf("文本内容超过 %d MB 上限", maxTextBytes>>20)
	}
	if info, statErr := os.Stat(clean); statErr == nil && info.IsDir() {
		return errors.New("目标是目录，无法写入文件")
	}
	if err := writeFileAtomic(clean, []byte(content), 0o600); err != nil {
		return fmt.Errorf("写入文件失败: %w", err)
	}
	return nil
}

// writeFileAtomic 在目标目录创建临时文件，写满并 fsync 后再原子重命名。
// 直接 os.WriteFile 会先截断目标：磁盘满、IO 错误或进程中途退出时，
// 用户原有的文件会变成 0 字节或半截内容且无法恢复。
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	// 目标是符号链接时写到它指向的真实文件：rename 会替换目录项本身，
	// 否则保存一次就会把链接变成普通文件，链接另一端的真实文件反而不更新。
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	// 覆盖已有文件时沿用原权限：os.WriteFile 不会修改已存在文件的权限，
	// 若这里固定 chmod 为传入值（0600），会把可执行脚本、组可读文件降权。
	if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
		perm = info.Mode().Perm()
	}
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".terminator-save-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()

	if _, err := tmp.Write(data); err != nil {
		return err
	}
	// fsync 确保 rename 之前内容已经落盘；否则掉电后可能留下 0 字节文件
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	// CreateTemp 使用 0600，显式 chmod 以匹配调用方期望的权限
	if err := os.Chmod(tmpName, perm); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	cleanup = false
	return nil
}

// readFileLimited 读取常规文件并强制大小上限。
// 不能只依赖 Stat.Size：FIFO 之类非常规文件会在打开时阻塞，
// /dev/zero 之类大小报告为 0 但读取无限增长，必须先拒绝非常规文件，
// 再用 LimitReader 兜底防止读取过程中文件被写大。
func readFileLimited(path string, maxBytes int64) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("读取文件失败: %w", err)
	}
	if info.IsDir() {
		return nil, errors.New("目标是目录，无法读取文件")
	}
	if !info.Mode().IsRegular() {
		return nil, errors.New("目标不是常规文件，无法读取")
	}
	if info.Size() > maxBytes {
		return nil, fmt.Errorf("文件超过 %d MB 上限", maxBytes>>20)
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("读取文件失败: %w", err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("读取文件失败: %w", err)
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("文件超过 %d MB 上限", maxBytes>>20)
	}
	return data, nil
}

// ReadText 读取用户选定的文本文件，超过上限时拒绝。
func (s *TextFileService) ReadText(path string) (string, error) {
	clean, err := validatePath(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(clean)
	if err != nil {
		return "", fmt.Errorf("读取文件失败: %w", err)
	}
	if info.IsDir() {
		return "", errors.New("目标是目录，无法读取文件")
	}
	if info.Size() > maxTextBytes {
		return "", fmt.Errorf("文件超过 %d MB 上限", maxTextBytes>>20)
	}
	data, err := readFileLimited(clean, maxTextBytes)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// ReadBinary 读取用户选定的二进制文件，返回 base64 编码内容。
// ZMODEM 上传需要精确的原始字节，Wails 的字符串参数按 UTF-8 传输，
// 因此统一用 base64 穿过 IPC，避免二进制内容被转码破坏。
func (s *TextFileService) ReadBinary(path string) (string, error) {
	clean, err := validatePath(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(clean)
	if err != nil {
		return "", fmt.Errorf("读取文件失败: %w", err)
	}
	if info.IsDir() {
		return "", errors.New("目标是目录，无法读取文件")
	}
	if info.Size() > maxBinaryBytes {
		return "", fmt.Errorf("文件超过 %d MB 上限", maxBinaryBytes>>20)
	}
	data, err := readFileLimited(clean, maxBinaryBytes)
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(data), nil
}

// SaveBinary 把 base64 编码的二进制内容写入用户选定的路径，已存在时覆盖。
func (s *TextFileService) SaveBinary(path string, contentBase64 string) error {
	clean, err := validatePath(path)
	if err != nil {
		return err
	}
	// 先按编码长度做一次粗校验，避免为超大内容分配解码缓冲区
	if len(contentBase64) > (maxBinaryBytes/3+1)*4 {
		return fmt.Errorf("文件超过 %d MB 上限", maxBinaryBytes>>20)
	}
	data, err := base64.StdEncoding.DecodeString(contentBase64)
	if err != nil {
		return fmt.Errorf("内容不是合法的 base64: %w", err)
	}
	if len(data) > maxBinaryBytes {
		return fmt.Errorf("文件超过 %d MB 上限", maxBinaryBytes>>20)
	}
	if info, statErr := os.Stat(clean); statErr == nil && info.IsDir() {
		return errors.New("目标是目录，无法写入文件")
	}
	if err := writeFileAtomic(clean, data, 0o600); err != nil {
		return fmt.Errorf("写入文件失败: %w", err)
	}
	return nil
}

// LocalHomeDir 返回当前用户的主目录，供双栏面板首次打开时定位。
func (s *TextFileService) LocalHomeDir() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("获取用户主目录失败: %w", err)
	}
	return home, nil
}

// ListLocalDir 列出本地目录内容（只读）。
// path 为空或是 ~ 开头时按用户主目录解析；返回目录本身、上级目录与条目列表。
func (s *TextFileService) ListLocalDir(path string) (*LocalListing, error) {
	home, _ := os.UserHomeDir()
	target := strings.TrimSpace(path)
	if strings.IndexByte(target, 0) >= 0 {
		return nil, errors.New("目录路径包含非法字符")
	}
	if target == "" {
		target = home
	}
	if target == "" {
		return nil, errors.New("无法确定本地目录")
	}
	// 支持 "~" 与 "~/xxx"：用户手动输入路径时的常见写法
	if strings.HasPrefix(target, "~") {
		if home == "" {
			return nil, errors.New("无法解析 ~ 路径")
		}
		rest := strings.TrimPrefix(target, "~")
		rest = strings.TrimPrefix(rest, string(filepath.Separator))
		target = filepath.Join(home, rest)
	}

	info, err := os.Stat(target)
	if err != nil {
		return nil, fmt.Errorf("读取本地目录失败: %w", err)
	}
	if !info.IsDir() {
		return nil, errors.New("目标不是目录")
	}
	dir := target
	if abs, absErr := filepath.Abs(dir); absErr == nil {
		dir = abs
	}

	dirents, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("读取本地目录失败: %w", err)
	}

	listing := &LocalListing{
		Path:    dir,
		Home:    home,
		Parent:  localParentDir(dir),
		Entries: make([]LocalEntry, 0, len(dirents)),
	}
	for _, de := range dirents {
		if len(listing.Entries) >= maxLocalEntries {
			listing.Truncated = true
			break
		}
		full := filepath.Join(dir, de.Name())
		entry := LocalEntry{Name: de.Name(), Path: full}
		// os.Stat 会跟随符号链接：目录链接按目录展示，失效链接保留为普通文件，
		// 避免用户看不到异常条目。
		if stat, statErr := os.Stat(full); statErr == nil {
			entry.IsDir = stat.IsDir()
			if !entry.IsDir {
				entry.Size = stat.Size()
			}
			entry.Modified = stat.ModTime().UnixMilli()
		}
		listing.Entries = append(listing.Entries, entry)
	}

	// 目录优先、名称不区分大小写：与远端 SFTP 列表的排序保持一致
	sort.SliceStable(listing.Entries, func(i, j int) bool {
		a, b := listing.Entries[i], listing.Entries[j]
		if a.IsDir != b.IsDir {
			return a.IsDir
		}
		an, bn := strings.ToLower(a.Name), strings.ToLower(b.Name)
		if an == bn {
			return a.Name < b.Name
		}
		return an < bn
	})
	return listing, nil
}

// localParentDir 返回上级目录；已到根目录或无法继续向上时返回空字符串。
func localParentDir(dir string) string {
	parent := filepath.Dir(dir)
	if parent == dir || parent == "." {
		return ""
	}
	return parent
}

// validateLocalWritePath 校验本地写操作路径。
// 与文本读写的宽松校验不同，这里强制要求绝对路径：双栏面板传入的都是
// 列表中的真实绝对路径，拒绝相对路径可以避免因进程工作目录不同而误操作。
func validateLocalWritePath(p string) (string, error) {
	clean := strings.TrimSpace(p)
	if clean == "" {
		return "", errors.New("路径不能为空")
	}
	if strings.IndexByte(clean, 0) >= 0 {
		return "", errors.New("路径包含非法字符")
	}
	if !filepath.IsAbs(clean) {
		return "", errors.New("路径必须是绝对路径")
	}
	return filepath.Clean(clean), nil
}

// sameLocalPath 按平台语义比较两个本地路径是否相同。
func sameLocalPath(a string, b string) bool {
	ca, cb := filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(ca, cb)
	}
	return ca == cb
}

// MkdirLocal 在本地创建目录；目录已存在时返回错误。
func (s *TextFileService) MkdirLocal(dirPath string) error {
	clean, err := validateLocalWritePath(dirPath)
	if err != nil {
		return err
	}
	if err := os.Mkdir(clean, 0o755); err != nil {
		return fmt.Errorf("创建本地目录失败: %w", err)
	}
	return nil
}

// RenameLocal 重命名本地文件或目录；目标已存在时拒绝，避免静默覆盖。
func (s *TextFileService) RenameLocal(oldPath string, newPath string) error {
	from, err := validateLocalWritePath(oldPath)
	if err != nil {
		return err
	}
	to, err := validateLocalWritePath(newPath)
	if err != nil {
		return err
	}
	if sameLocalPath(from, to) {
		return errors.New("新旧路径相同")
	}
	if _, err := os.Stat(from); err != nil {
		return fmt.Errorf("读取本地路径失败: %w", err)
	}
	if _, err := os.Stat(to); err == nil {
		return errors.New("目标路径已存在")
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("检查目标路径失败: %w", err)
	}
	if err := os.Rename(from, to); err != nil {
		return fmt.Errorf("重命名失败: %w", err)
	}
	return nil
}

// RemoveLocal 删除本地文件或目录。
// recursive=false 时只能删除空目录；recursive=true 允许递归删除目录内容。
// 根目录与用户主目录本身始终拒绝删除，避免一次误操作造成不可恢复的损失。
func (s *TextFileService) RemoveLocal(target string, recursive bool) error {
	clean, err := validateLocalWritePath(target)
	if err != nil {
		return err
	}
	if filepath.Dir(clean) == clean {
		return errors.New("不能删除根目录")
	}
	if home, homeErr := os.UserHomeDir(); homeErr == nil && home != "" && sameLocalPath(clean, home) {
		return errors.New("不能删除用户主目录")
	}

	info, err := os.Stat(clean)
	if err != nil {
		return fmt.Errorf("读取本地路径失败: %w", err)
	}
	if !info.IsDir() {
		if err := os.Remove(clean); err != nil {
			return fmt.Errorf("删除文件失败: %w", err)
		}
		return nil
	}
	if !recursive {
		// os.Remove 只能删空目录：非空时返回明确错误，提示用户需要确认递归删除
		if err := os.Remove(clean); err != nil {
			return fmt.Errorf("删除目录失败（非空目录需要确认递归删除）: %w", err)
		}
		return nil
	}
	if err := os.RemoveAll(clean); err != nil {
		return fmt.Errorf("删除目录失败: %w", err)
	}
	return nil
}

func validatePath(path string) (string, error) {
	clean := strings.TrimSpace(path)
	if clean == "" {
		return "", errors.New("文件路径不能为空")
	}
	if strings.IndexByte(clean, 0) >= 0 {
		return "", errors.New("文件路径包含非法字符")
	}
	return clean, nil
}
