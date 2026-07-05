package settings

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

type AppSettings struct {
	Language string `json:"language"`
	Theme    string `json:"theme"` // "dark", "light", or "" (default: dark)

	// SyncMethod 同步方式: "server" | "webdav" | "" (默认 server)
	SyncMethod string `json:"sync_method"`
	// WebDAV 相关配置，明文存储在 settings.json（和网盘密码一样，用户自己负责）
	WebDAVURL      string `json:"webdav_url"`
	WebDAVUsername string `json:"webdav_username"`
	WebDAVPassword string `json:"webdav_password"`
}

type SettingsService struct {
	configPath string
	logPath    string
	mutex      sync.RWMutex
}

func NewSettingsService(appDir string) *SettingsService {
	return &SettingsService{
		configPath: filepath.Join(appDir, "settings.json"),
		logPath:    filepath.Join(appDir, "terminator.log"),
	}
}

func (s *SettingsService) GetSettings() (AppSettings, error) {
	s.mutex.RLock()
	defer s.mutex.RUnlock()

	settings := AppSettings{
		Language: "zh",
		Theme:    "dark",
	}

	data, err := os.ReadFile(s.configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return settings, nil
		}
		return settings, err
	}

	err = json.Unmarshal(data, &settings)
	if err != nil {
		return settings, err
	}

	return settings, nil
}

func (s *SettingsService) SaveSettings(settings AppSettings) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(s.configPath, data, 0600)
}

// GetLogs 读取日志文件内容，返回最后 maxLines 行
func (s *SettingsService) GetLogs(maxLines int) (string, error) {
	if maxLines <= 0 {
		maxLines = 500
	}
	content, err := os.ReadFile(s.logPath)
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
func (s *SettingsService) ClearLogs() error {
	return os.WriteFile(s.logPath, []byte{}, 0644)
}
