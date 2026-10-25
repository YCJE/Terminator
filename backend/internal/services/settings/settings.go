package settings

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
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
	AccentColor       string  `json:"accent_color"`        // "monochrome"|"sky"|"emerald"|"violet"|"amber"|"rose"|"cyan" (默认 sky)
	Spaciness         float64 `json:"spaciness"`           // 0.8|1|1.2 (默认 1)
	Skin              string  `json:"skin"`                // 外观皮肤 "default"|"hud"|"editorial" (默认 default)
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
	if raw.Skin != "" {
		def.Skin = raw.Skin
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
		AccentColor:             "sky",
		Spaciness:               1,
		Skin:                    "default",
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
		if err := json.Unmarshal(data, &existing); err != nil {
			// 配置文件已损坏：不能用零值参与下方的"传入为空则沿用旧值"合并，
			// 否则合并逻辑全部失效，WebDAV 凭据等字段会被静默清空且无从察觉。
			// 宁可直接拒绝本次保存，也不要用零值把用户数据覆盖掉。
			return fmt.Errorf("配置文件已损坏，拒绝覆盖以避免丢失现有设置（请先修复或删除 %s）: %w", s.configPath, err)
		}
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
		Skin:                    settings.Skin,
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
	if merged.Skin == "" && existing.Skin != "" {
		merged.Skin = existing.Skin
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
	validSkins := map[string]bool{"default": true, "hud": true, "editorial": true}
	validSync := map[string]bool{"server": true, "webdav": true}

	if !validThemes[merged.Theme] {
		merged.Theme = def.Theme
	}
	if !validAccents[merged.AccentColor] {
		merged.AccentColor = def.AccentColor
	}
	if !validSkins[merged.Skin] {
		merged.Skin = def.Skin
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
	if merged.Skin != def.Skin {
		sanitized.Skin = merged.Skin
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
		// 写入失败（磁盘满、权限）时同 rename 分支一样清理残留临时文件，
		// 避免下次启动把半截 .tmp 误当作配置或被误读
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, s.configPath); err != nil {
		// rename 失败时清理残留临时文件，避免下次写入被误当作配置
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

// maxLogReadBytes 单次读取日志文件的字节上限。
//
// 日志文件没有轮转，长期运行后可达成百 MB。只为返回最后几百行而把整个文件
// 读进内存属于无谓的内存放大（可致界面卡死或 OOM），因此只从尾部读取有限窗口。
const maxLogReadBytes = 4 << 20

// GetLogs 读取日志文件内容，返回最后 maxLines 行
func (s *SettingsService) GetLogs(maxLines int) (string, error) {
	if maxLines <= 0 {
		maxLines = 500
	}

	f, err := os.Open(s.logPath)
	if err != nil {
		return "", fmt.Errorf("读取日志失败: %w", err)
	}
	defer func() { _ = f.Close() }()

	info, err := f.Stat()
	if err != nil {
		return "", fmt.Errorf("读取日志失败: %w", err)
	}

	// 仅当文件超过读取上限时，从尾部窗口开始读
	var offset int64
	if size := info.Size(); size > maxLogReadBytes {
		offset = size - maxLogReadBytes
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return "", fmt.Errorf("读取日志失败: %w", err)
	}

	data, err := io.ReadAll(f)
	if err != nil {
		return "", fmt.Errorf("读取日志失败: %w", err)
	}
	if offset > 0 {
		// 窗口起点很可能落在某行的中间：丢弃首个不完整行，
		// 避免向用户展示一条被截断的日志。
		idx := bytes.IndexByte(data, '\n')
		if idx < 0 {
			data = nil
		} else {
			data = data[idx+1:]
		}
	}

	lines := strings.Split(string(data), "\n")
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return strings.Join(lines, "\n"), nil
}

// ClearLogs 清空日志文件
func (s *SettingsService) ClearLogs() error {
	return os.WriteFile(s.logPath, []byte{}, 0600)
}
