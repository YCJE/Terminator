package main

import (
	"errors"
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
	current.WebDAVPassword = password

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
