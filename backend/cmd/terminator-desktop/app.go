package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"terminator-desktop/backend/internal/services/settings"
	"terminator-desktop/backend/internal/webdav"
)

// WebDAVService 暴露给前端的 WebDAV 配置管理服务。
// WebDAV 配置存储在 settings.json（AppSettings），不存 DB。
type WebDAVService struct {
	settingsSvc *settings.SettingsService
}

// NewWebDAVService 创建 WebDAVService
func NewWebDAVService(settingsSvc *settings.SettingsService) *WebDAVService {
	return &WebDAVService{settingsSvc: settingsSvc}
}

// TestWebDAVConnection 测试 WebDAV 连接是否可用（前端调用，无需解锁 vault）
func (s *WebDAVService) TestWebDAVConnection(url, username, password string) error {
	if url == "" {
		return errors.New("WebDAV URL 不能为空")
	}
	return webdav.TestConnection(url, username, password)
}

// SaveWebDAVConfig 保存 WebDAV 配置到 settings.json，并将同步方式切换为 webdav。
// 密码明文存储在 settings.json（和网盘密码一样，用户自己负责）。
// 如果 password 为空，保留原有密码（编辑配置时不强制重新输入密码）。
func (s *WebDAVService) SaveWebDAVConfig(url, username, password string) error {
	if url == "" {
		return errors.New("WebDAV URL 不能为空")
	}

	current, err := s.settingsSvc.GetSettings()
	if err != nil {
		return err
	}

	current.SyncMethod = "webdav"
	current.WebDAVURL = url
	current.WebDAVUsername = username
	// 密码为空时保留原密码，避免编辑配置时意外清空密码
	if password != "" {
		current.WebDAVPassword = password
	}

	return s.settingsSvc.SaveSettings(current)
}

// GetWebDAVConfig 获取 WebDAV 配置，出于安全考虑不返回密码
func (s *WebDAVService) GetWebDAVConfig() (url, username string, err error) {
	current, err := s.settingsSvc.GetSettings()
	if err != nil {
		return "", "", err
	}
	return current.WebDAVURL, current.WebDAVUsername, nil
}

// LogService 暴露给前端的日志查看服务
type LogService struct {
	appDir string
}

// NewLogService 创建 LogService
func NewLogService(appDir string) *LogService {
	return &LogService{appDir: appDir}
}

// GetLogs 读取日志文件内容，返回最后 maxLines 行
func (s *LogService) GetLogs(maxLines int) (string, error) {
	if maxLines <= 0 {
		maxLines = 500
	}
	logPath := filepath.Join(s.appDir, logFileName)
	content, err := os.ReadFile(logPath)
	if err != nil {
		return "", fmt.Errorf("读取日志失败: %w", err)
	}
	lines := strings.Split(string(content), "\n")
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return strings.Join(lines, "\n"), nil
}

// ClearLogs 清空日志文件
func (s *LogService) ClearLogs() error {
	logPath := filepath.Join(s.appDir, logFileName)
	return os.WriteFile(logPath, []byte{}, 0666)
}
