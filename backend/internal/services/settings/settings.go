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

	// 外观偏好
	AccentColor       string  `json:"accent_color"`        // "sky"|"emerald"|"violet"|"amber"|"rose"|"cyan" (默认 sky)
	Spaciness         float64 `json:"spaciness"`           // 0.8|1|1.2 (默认 1)
	TerminalColorLink bool    `json:"terminal_color_link"` // 终端配色联动 (默认 false)
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

	def := defaultSettings()

	data, err := os.ReadFile(s.configPath)
	if err != nil {
		if os.IsNotExist(err) {
			return def, nil
		}
		return def, err
	}

	var raw AppSettings
	err = json.Unmarshal(data, &raw)
	if err != nil {
		return def, err
	}

	// 合并：空字符串字段使用默认值（ConfigProxy 擦除后空字段表示"使用默认"）
	if raw.Language != "" {
		def.Language = raw.Language
	}
	if raw.Theme != "" {
		def.Theme = raw.Theme
	}
	if raw.SyncMethod != "" {
		def.SyncMethod = raw.SyncMethod
	}
	def.WebDAVURL = raw.WebDAVURL
	def.WebDAVUsername = raw.WebDAVUsername
	def.WebDAVPassword = raw.WebDAVPassword

	// 外观偏好：空值/零值使用默认值
	if raw.AccentColor != "" {
		def.AccentColor = raw.AccentColor
	}
	if raw.Spaciness != 0 {
		def.Spaciness = raw.Spaciness
	}
	def.TerminalColorLink = raw.TerminalColorLink

	return def, nil
}

// defaultSettings 返回默认设置值
// 借鉴 Tabby 的 ConfigProxy：保存时自动擦除等于默认值的字段，配置文件只保留用户实际修改项
func defaultSettings() AppSettings {
	return AppSettings{
		Language:          "zh",
		Theme:             "dark",
		SyncMethod:        "server",
		AccentColor:       "sky",
		Spaciness:         1,
		TerminalColorLink: false,
	}
}

func (s *SettingsService) SaveSettings(settings AppSettings) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	// ConfigProxy 默认值擦除：等于默认值的字段不写入配置文件
	// 这样 settings.json 只包含用户实际修改的项，保持精简
	def := defaultSettings()
	sanitized := AppSettings{
		Language:       "",
		Theme:          "",
		SyncMethod:     "",
		WebDAVURL:      settings.WebDAVURL,
		WebDAVUsername: settings.WebDAVUsername,
		WebDAVPassword: settings.WebDAVPassword,
	}
	if settings.Language != def.Language {
		sanitized.Language = settings.Language
	}
	if settings.Theme != def.Theme {
		sanitized.Theme = settings.Theme
	}
	if settings.SyncMethod != def.SyncMethod {
		sanitized.SyncMethod = settings.SyncMethod
	}

	// 外观偏好
	if settings.AccentColor != def.AccentColor {
		sanitized.AccentColor = settings.AccentColor
	}
	if settings.Spaciness != def.Spaciness {
		sanitized.Spaciness = settings.Spaciness
	}
	if settings.TerminalColorLink != def.TerminalColorLink {
		sanitized.TerminalColorLink = settings.TerminalColorLink
	}

	data, err := json.MarshalIndent(sanitized, "", "  ")
	if err != nil {
		return err
	}

	// 原子写：先写临时文件再 rename，防止写入中途崩溃损坏配置
	tmpPath := s.configPath + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmpPath, s.configPath)
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
	return os.WriteFile(s.logPath, []byte{}, 0600)
}
