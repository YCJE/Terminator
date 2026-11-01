//go:build windows

package settings

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const (
	// autoStartRunKey 当前用户的启动项注册表路径，无需管理员权限即可写入。
	autoStartRunKey = `Software\Microsoft\Windows\CurrentVersion\Run`
	// autoStartValueName 注册表值名。固定名称便于关闭时精确删除，
	// 也避免与其他程序（如开发版）的启动项混淆。
	autoStartValueName = "Terminator"
)

// GetAutoStart 查询当前用户是否已启用开机自启。
//
// 判断标准是注册表项存在且指向当前可执行文件：升级或更改安装目录后，
// 旧路径残留的启动项会让程序"看起来已启用"却启动失败，这里视为未启用，
// 用户重新打开开关即可写入新路径。
func (s *SettingsService) GetAutoStart() (bool, error) {
	key, err := registry.OpenKey(registry.CURRENT_USER, autoStartRunKey, registry.QUERY_VALUE)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("读取开机自启注册表项失败: %w", err)
	}
	defer func() { _ = key.Close() }()

	value, _, err := key.GetStringValue(autoStartValueName)
	if err != nil {
		if errors.Is(err, registry.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("读取开机自启注册表值失败: %w", err)
	}
	return autoStartMatches(value), nil
}

// SetAutoStart 开启或关闭开机自启（写当前用户的 Run 键）。
func (s *SettingsService) SetAutoStart(enabled bool) error {
	key, _, err := registry.CreateKey(
		registry.CURRENT_USER,
		autoStartRunKey,
		registry.SET_VALUE|registry.QUERY_VALUE,
	)
	if err != nil {
		return fmt.Errorf("打开开机自启注册表项失败: %w", err)
	}
	defer func() { _ = key.Close() }()

	if !enabled {
		// 值不存在时删除会返回 ErrNotExist，属于正常的"本来就没开"
		if err := key.DeleteValue(autoStartValueName); err != nil && !errors.Is(err, registry.ErrNotExist) {
			return fmt.Errorf("关闭开机自启失败: %w", err)
		}
		return nil
	}

	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("获取程序路径失败: %w", err)
	}
	exe, err = filepath.Abs(exe)
	if err != nil {
		return fmt.Errorf("解析程序路径失败: %w", err)
	}
	// 路径必须加引号：安装目录常含空格，Windows 会把未加引号的路径从空格处截断
	if err := key.SetStringValue(autoStartValueName, `"`+exe+`"`); err != nil {
		return fmt.Errorf("写入开机自启失败: %w", err)
	}
	return nil
}

// autoStartMatches 判断注册表值与当前可执行文件是否为同一路径。
// 比较时忽略引号、空白与大小写：Windows 路径大小写不敏感。
func autoStartMatches(value string) bool {
	current, err := os.Executable()
	if err != nil {
		return false
	}
	normalize := func(p string) string {
		p = strings.Trim(strings.TrimSpace(p), `"`)
		return strings.ToLower(filepath.Clean(p))
	}
	value = strings.TrimSpace(value)
	// 兼容注册表里可能出现的前置参数（如 `"C:\path\app.exe" --autostart`）
	if idx := strings.Index(value, `.exe"`); idx >= 0 {
		value = value[:idx+len(".exe")]
	}
	return normalize(value) == normalize(current)
}
