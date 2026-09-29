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

	// 会话日志：把完整终端输出写入磁盘。输出中可能包含用户输入的
	// 口令、令牌、连接串等敏感内容，因此默认关闭，开启后按保留期回收。
	SessionLogEnabled       bool `json:"session_log_enabled"`        // 默认 false
	SessionLogRetentionDays int  `json:"session_log_retention_days"` // 默认 7 天
}

// sessionLogRetentionMin/Max 限定保留期取值范围。
// 下界避免设置为 0 导致日志刚写出就被判定过期；
// 上界避免误填大数使清理形同虚设。
const (
	sessionLogRetentionMin = 1
	sessionLogRetentionMax = 365
)

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

	// 会话日志：bool 无法区分"未设置"与 false，直接采用磁盘值，
	// 与 TerminalColorLink 的处理方式一致
	def.SessionLogEnabled = raw.SessionLogEnabled
	if raw.SessionLogRetentionDays != 0 {
		def.SessionLogRetentionDays = raw.SessionLogRetentionDays
	}

	return def, nil
}

// defaultSettings 返回默认设置值
// 借鉴 Tabby 的 ConfigProxy：保存时自动擦除等于默认值的字段，配置文件只保留用户实际修改项
func defaultSettings() AppSettings {
	return AppSettings{
		Language:                "zh",
		Theme:                   "dark",
		SyncMethod:              "server",
		AccentColor:             "monochrome",
		Spaciness:               1,
		TerminalColorLink:       false,
		SessionLogEnabled:       false,
		SessionLogRetentionDays: 7,
	}
}

// SessionLogEnabled 供 SSH 服务在建立会话时查询日志开关。
//
// 读取失败时返回 false：会话日志会把完整终端内容明文落盘，
// 配置不可信时宁可不记录，也不要凭默认值意外开启。
func (s *SettingsService) SessionLogEnabled() bool {
	settings, err := s.GetSettings()
	if err != nil {
		return false
	}
	return settings.SessionLogEnabled
}

// SessionLogRetentionDays 返回会话日志保留天数（已按合法区间收敛）。
func (s *SettingsService) SessionLogRetentionDays() int {
	settings, err := s.GetSettings()
	if err != nil {
		return defaultSettings().SessionLogRetentionDays
	}
	return settings.SessionLogRetentionDays
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
		Language:                settings.Language,
		Theme:                   settings.Theme,
		SyncMethod:              settings.SyncMethod,
		WebDAVURL:               settings.WebDAVURL,
		WebDAVUsername:          settings.WebDAVUsername,
		WebDAVPassword:          settings.WebDAVPassword,
		AccentColor:             settings.AccentColor,
		Spaciness:               settings.Spaciness,
		TerminalColorLink:       settings.TerminalColorLink,
		SessionLogEnabled:       settings.SessionLogEnabled,
		SessionLogRetentionDays: settings.SessionLogRetentionDays,
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
	// SessionLogEnabled 与 TerminalColorLink 同理：前端始终发送完整设置对象，
	// 直接采用传入值，否则用户无法从 true 关回 false。
	// 保留期为零值视为"未提供"，沿用磁盘上的值。
	if merged.SessionLogRetentionDays == 0 && existing.SessionLogRetentionDays != 0 {
		merged.SessionLogRetentionDays = existing.SessionLogRetentionDays
	}
	// TerminalColorLink: 前端始终发送完整设置对象，无需部分合并
	// 之前用 !merged.TerminalColorLink && existing.TerminalColorLink 保留旧值，
	// 但这导致用户无法从 true 切换到 false。移除此合并逻辑，直接使用前端传入的值。

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
	// 保留期收敛到合法区间：越界值回退为默认，
	// 避免 0（日志刚写出即过期）或极大值（清理失效）被写入配置
	if merged.SessionLogRetentionDays < sessionLogRetentionMin || merged.SessionLogRetentionDays > sessionLogRetentionMax {
		merged.SessionLogRetentionDays = def.SessionLogRetentionDays
	}

	// ConfigProxy 默认值擦除：等于默认值的字段不写入配置文件
	sanitized := AppSettings{
		WebDAVURL:      merged.WebDAVURL,
		WebDAVUsername: merged.WebDAVUsername,
		WebDAVPassword: merged.WebDAVPassword,
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
	if merged.SessionLogEnabled != def.SessionLogEnabled {
		sanitized.SessionLogEnabled = merged.SessionLogEnabled
	}
	if merged.SessionLogRetentionDays != def.SessionLogRetentionDays {
		sanitized.SessionLogRetentionDays = merged.SessionLogRetentionDays
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
