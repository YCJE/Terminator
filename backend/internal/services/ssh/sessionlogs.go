package ssh

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// SessionLogFile 描述一个会话日志文件。
type SessionLogFile struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	ModTime string `json:"modTime"`
}

// SessionLogMatch 描述一次会话日志检索命中。
type SessionLogMatch struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

// 日志检索上限：日志为无轮转的原始终端输出，全量扫描可能非常耗时，
// 因此同时限制文件数、扫描字节数与命中数，保证操作有界。
const (
	maxSessionLogFiles = 50
	maxSessionLogScan  = 16 << 20
	maxSessionLogMatch = 200
	maxSessionLogRead  = 2 << 20
)

// ansiEscape 匹配终端控制序列（CSI/OSC/其他 ESC），检索结果中剥除，
// 否则返回给前端的文本会夹杂大量不可见控制字符。
var (
	ansiOSC = regexp.MustCompile("\x1b\\][^\x07\x1b]*(?:\x07|\x1b\\\\)")
	ansiCSI = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]")
	ansiESC = regexp.MustCompile("\x1b[@-Z\\\\-_]")
)

func stripANSI(s string) string {
	s = ansiOSC.ReplaceAllString(s, "")
	s = ansiCSI.ReplaceAllString(s, "")
	s = ansiESC.ReplaceAllString(s, "")
	return strings.ReplaceAll(s, "\r", "")
}

// ListSessionLogs 列出会话日志文件，按修改时间倒序。
func (s *SshService) ListSessionLogs() ([]SessionLogFile, error) {
	dir, err := s.sessionLogDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		// 尚未产生任何会话日志时目录可能不存在，按空列表处理
		if os.IsNotExist(err) {
			return []SessionLogFile{}, nil
		}
		return nil, fmt.Errorf("读取会话日志目录失败: %w", err)
	}

	files := make([]SessionLogFile, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, ierr := entry.Info()
		if ierr != nil {
			continue
		}
		files = append(files, SessionLogFile{
			Name:    entry.Name(),
			Size:    info.Size(),
			ModTime: info.ModTime().Format(time.RFC3339),
		})
	}
	sort.Slice(files, func(i, j int) bool {
		return files[i].ModTime > files[j].ModTime
	})
	return files, nil
}

// ReadSessionLog 读取指定日志文件的末尾 maxLines 行。
func (s *SshService) ReadSessionLog(name string, maxLines int) (string, error) {
	if maxLines <= 0 {
		maxLines = 500
	}
	dir, err := s.sessionLogDir()
	if err != nil {
		return "", err
	}
	path, err := safeSessionLogPath(dir, name)
	if err != nil {
		return "", err
	}

	f, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("打开日志文件失败: %w", err)
	}
	defer func() { _ = f.Close() }()

	info, err := f.Stat()
	if err != nil {
		return "", fmt.Errorf("读取日志文件失败: %w", err)
	}
	var offset int64
	if size := info.Size(); size > maxSessionLogRead {
		offset = size - maxSessionLogRead
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return "", fmt.Errorf("读取日志文件失败: %w", err)
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return "", fmt.Errorf("读取日志文件失败: %w", err)
	}
	if offset > 0 {
		// 从中间开始读时丢弃首个不完整行
		if idx := strings.IndexByte(string(data), '\n'); idx >= 0 {
			data = data[idx+1:]
		}
	}

	lines := strings.Split(stripANSI(string(data)), "\n")
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return strings.Join(lines, "\n"), nil
}

// SearchSessionLogs 在所有会话日志中检索关键字（不区分大小写），返回命中行。
func (s *SshService) SearchSessionLogs(query string, limit int) ([]SessionLogMatch, error) {
	q := strings.TrimSpace(query)
	if q == "" {
		return nil, fmt.Errorf("搜索关键字不能为空")
	}
	if limit <= 0 || limit > maxSessionLogMatch {
		limit = 100
	}

	dir, err := s.sessionLogDir()
	if err != nil {
		return nil, err
	}
	files, err := s.ListSessionLogs()
	if err != nil {
		return nil, err
	}
	if len(files) > maxSessionLogFiles {
		files = files[:maxSessionLogFiles]
	}

	lowerQuery := strings.ToLower(q)
	matches := make([]SessionLogMatch, 0, limit)
	var scanned int64

	for _, file := range files {
		if len(matches) >= limit || scanned >= maxSessionLogScan {
			break
		}
		path, perr := safeSessionLogPath(dir, file.Name)
		if perr != nil {
			continue
		}
		f, oerr := os.Open(path)
		if oerr != nil {
			continue
		}
		reader := bufio.NewReaderSize(f, 64*1024)
		lineNo := 0
		for {
			line, rerr := reader.ReadString('\n')
			if len(line) > 0 {
				scanned += int64(len(line))
				lineNo++
				if strings.Contains(strings.ToLower(line), lowerQuery) {
					text := stripANSI(strings.TrimRight(line, "\r\n"))
					// 按 rune 截断：日志常含中文，按字节切片会把多字节字符
					// 从中间截断，返回给前端的 JSON 会出现替换字符。
					text = truncateRunes(text, 400)
					matches = append(matches, SessionLogMatch{File: file.Name, Line: lineNo, Text: text})
					if len(matches) >= limit {
						break
					}
				}
				if scanned >= maxSessionLogScan {
					break
				}
			}
			if rerr != nil {
				break
			}
		}
		_ = f.Close()
	}

	return matches, nil
}

// sessionLogDir 返回会话日志目录，未配置时返回错误。
func (s *SshService) sessionLogDir() (string, error) {
	if strings.TrimSpace(s.logDir) == "" {
		return "", fmt.Errorf("会话日志目录未配置")
	}
	return s.logDir, nil
}

// safeSessionLogPath 校验文件名并返回日志目录内的完整路径。
// 只接受 UUID 风格的基名（字母、数字、点、下划线、连字符），杜绝路径穿越。
func safeSessionLogPath(dir, name string) (string, error) {
	if name == "" || name == "." || name == ".." || name != filepath.Base(name) {
		return "", fmt.Errorf("非法日志文件名")
	}
	for _, r := range name {
		valid := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '.' || r == '_' || r == '-'
		if !valid {
			return "", fmt.Errorf("非法日志文件名")
		}
	}
	return filepath.Join(dir, name), nil
}

// truncateRunes 按 rune 数截断字符串，保留前 max 个字符。
// 与按字节切片不同，不会把一个多字节字符切成两半。
func truncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	count := 0
	for i := range s {
		if count == max {
			return s[:i] + "…"
		}
		count++
	}
	return s
}
