package main

import (
	"context"
	"errors"
	"terminator-desktop/backend/internal/services/settings"
	"terminator-desktop/backend/internal/webdav"
)

// WebDAVService 暴露给前端的 WebDAV 配置管理服务。
// WebDAV 配置存储在 settings.json（AppSettings），不存 DB。
type WebDAVService struct {
	settingsSvc *settings.SettingsService
	// resetSyncCursor 清除增量同步游标。切换同步方式后，旧游标来自另一种
	// 时钟（服务器 SyncTime / 本地时间），继续作为冲突检测基准会失真。
	resetSyncCursor func(context.Context) error
}

// NewWebDAVService 创建 WebDAVService
func NewWebDAVService(settingsSvc *settings.SettingsService, resetSyncCursor func(context.Context) error) *WebDAVService {
	return &WebDAVService{settingsSvc: settingsSvc, resetSyncCursor: resetSyncCursor}
}

// TestWebDAVConnection 测试 WebDAV 连接是否可用（前端调用，无需解锁 vault）
func (s *WebDAVService) TestWebDAVConnection(url, username, password string) error {
	if url == "" {
		return errors.New("WebDAV URL 不能为空")
	}
	// 密码字段留空表示"沿用已保存的密码"，与 SaveWebDAVConfig 语义一致。
	// 若此处直接拿空密码去请求，编辑既有配置时点"测试连接"会必然 401，
	// 让用户误以为已保存的凭据失效。
	if password == "" {
		if current, err := s.settingsSvc.GetSettingsWithSecrets(); err == nil {
			password = current.WebDAVPassword
		}
	}
	return webdav.TestConnection(context.Background(), url, username, password)
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

	// 先清除上一同步方式留下的游标，再保存配置：清除失败时配置保持原样，
	// 避免出现"已切到 WebDAV、却仍拿服务器时钟的游标当冲突基准"的状态。
	// 反向顺序（先保存后清除）若清除失败，配置已切换且游标失真，更难恢复。
	if s.resetSyncCursor != nil {
		if err := s.resetSyncCursor(context.Background()); err != nil {
			return err
		}
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
