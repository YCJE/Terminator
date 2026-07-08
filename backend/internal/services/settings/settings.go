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
	AccentColor       string  `json:"accent_color"`        // "monochrome"|"sky"|"emerald"|"violet"|"amber"|"rose"|"cyan" (默认 monochrome)
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
		AccentColor:       "monochrome",
		Spaciness:         1,
		TerminalColorLink: false,
	}
}

func (s *SettingsService) SaveSettings(settings AppSettings) error {
	s.mutex.Lock()
	defer s.mutex.Unlock()

	// 先读取磁盘上的现有配置，与传入值合并
	// 防止调用方发送部分设置时覆盖未包含的字段（如 WebDAV 凭据）
	var existing AppSettings
	if data, err := os.ReadFile(s.configPath); err == nil {
		_ = json.Unmarshal(data, &existing)
	}
	merged := AppSettings{
		Language:          settings.Language,
		Theme:             settings.Theme,
		SyncMethod:        settings.SyncMethod,
		WebDAVURL:         settings.WebDAVURL,
		WebDAVUsername:    settings.WebDAVUsername,
		WebDAVPassword:    settings.WebDAVPassword,
		AccentColor:       settings.AccentColor,
		Spaciness:         settings.Spaciness,
		TerminalColorLink: settings.TerminalColorLink,
	}
	// 如果调用方传入空字符串/零值，保留现有值
	if merged.Language == "" && existing.Language != "" {
		merged.Language = existing.Language
	}
	if merged.Theme == "" && existing.Theme != "" {
		merged.Theme = existing.Theme
	}
	if merged.SyncMethod == "" && existing.SyncMethod != "" {
		merged.SyncMethod = existing.SyncMethod
	}
	if merged.WebDAVURL == "" && existing.WebDAVURL != "" {
		merged.WebDAVURL = existing.WebDAVURL
	}
	if merged.WebDAVUsername == "" && existing.WebDAVUsername != "" {
		merged.WebDAVUsername = existing.WebDAVUsername
	}
	if merged.WebDAVPassword == "" && existing.WebDAVPassword != "" {
		merged.WebDAVPassword = existing.WebDAVPassword
	}
	if merged.AccentColor == "" && existing.AccentColor != "" {
		merged.AccentColor = existing.AccentColor
	}
	if merged.Spaciness == 0 && existing.Spaciness != 0 {
		merged.Spaciness = existing.Spaciness
	}
	// TerminalColorLink 是 bool，零值 false 无法区分"未提供"与"显式关闭"
	// 当前端发送部分更新时（不含 terminalColorLink），保留现有值
	if !merged.TerminalColorLink && existing.TerminalColorLink {
		merged.TerminalColorLink = existing.TerminalColorLink
	}

	// 值合法性校验：非法值回退为默认值
	def := defaultSettings()
	validThemes := map[string]bool{"dark": true, "light": true}
	validAccents := map[string]bool{"monochrome": true, "sky": true, "emerald": true, "violet": true, "amber": true, "rose": true, "cyan": true}
	validSync := map[string]bool{"server": true, "webdav": true}

	if !validThemes[merged.Theme] {
		merged.Theme = def.Theme
	}
	if !validAccents[merged.AccentColor] {
		merged.AccentColor = def.AccentColor
	}
	if !validSync[merged.SyncMethod] {
		merged.SyncMethod = def.SyncMethod
	}
	if merged.Spaciness != 0.8 && merged.Spaciness != 1 && merged.Spaciness != 1.2 {
		merged.Spaciness = def.Spaciness
	}

	// ConfigProxy 默认值擦除：等于默认值的字段不写入配置文件
	sanitized := AppSettings{
		WebDAVURL:         merged.WebDAVURL,
		WebDAVUsername:    merged.WebDAVUsername,
		WebDAVPassword:    merged.WebDAVPassword,
	}
	if merged.Language != def.Language {
		sanitized.Language = merged.Language
	}
	if merged.Theme != def.Theme {
		sanitized.Theme = merged.Theme
	}
	if merged.SyncMethod != def.SyncMethod {
		sanitized.SyncMethod = merged.SyncMethod
	}
	if merged.AccentColor != def.AccentColor {
		sanitized.AccentColor = merged.AccentColor
	}
	if merged.Spaciness != def.Spaciness {
		sanitized.Spaciness = merged.Spaciness
	}
	if merged.TerminalColorLink != def.TerminalColorLink {
		sanitized.TerminalColorLink = merged.TerminalColorLink
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
