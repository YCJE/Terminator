//go:build !windows

package settings

import "errors"

var errAutoStartUnsupported = errors.New("开机自启仅支持 Windows")

// GetAutoStart 在非 Windows 平台恒为未启用。
func (s *SettingsService) GetAutoStart() (bool, error) {
	return false, errAutoStartUnsupported
}

// SetAutoStart 在非 Windows 平台不支持。
func (s *SettingsService) SetAutoStart(enabled bool) error {
	return errAutoStartUnsupported
}
