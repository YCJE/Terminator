package blob

import (
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
)

// SSHConfigHost 是 ~/.ssh/config 中一个可导入的主机条目。
type SSHConfigHost struct {
	Alias        string `json:"alias"`                  // Host 别名
	Host         string `json:"host"`                   // HostName，缺省时等于 Alias
	Port         int    `json:"port"`                   // Port，缺省 22
	Username     string `json:"username"`               // User，缺省为当前系统用户
	IdentityFile string `json:"identityFile,omitempty"` // 私钥路径（已展开 ~）
	ProxyJump    string `json:"proxyJump,omitempty"`    // ProxyJump 原始值
}

// ParseSSHConfig 解析当前用户的 ~/.ssh/config，返回可用于导入的主机条目。
//
// 仅支持常用指令（Host/HostName/User/Port/IdentityFile/ProxyJump）；包含通配符的
// Host 模式（如 *.example.com）与 Match 块会被跳过，避免把一条模板展开成大量
// 语义不确定的主机。Include 不展开：被包含文件的内容无法保证可安全合并。
func (s *HostService) ParseSSHConfig() ([]SSHConfigHost, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("无法定位用户主目录: %w", err)
	}
	path := filepath.Join(home, ".ssh", "config")
	entries, err := parseSSHConfigFile(path)
	if err != nil {
		return nil, err
	}
	return entries, nil
}

func parseSSHConfigFile(path string) ([]SSHConfigHost, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("未找到 SSH 配置文件 %s", path)
		}
		return nil, fmt.Errorf("读取 SSH 配置失败: %w", err)
	}

	defaultUser := ""
	if u, uerr := user.Current(); uerr == nil {
		defaultUser = u.Username
	}

	var (
		entries []SSHConfigHost
		current *SSHConfigHost
		// inMatch 为 true 时忽略后续指令，直到下一个 Host 行
		inMatch bool
		seen    = make(map[string]bool)
	)

	flush := func() {
		if current == nil {
			return
		}
		if current.Host == "" {
			current.Host = current.Alias
		}
		if current.Port == 0 {
			current.Port = 22
		}
		if current.Username == "" {
			current.Username = defaultUser
		}
		entries = append(entries, *current)
		current = nil
	}

	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value := splitSSHConfigLine(line)
		switch strings.ToLower(key) {
		case "host":
			flush()
			inMatch = false
			alias := firstAliasWithoutWildcard(value)
			if alias == "" {
				current = nil
				continue
			}
			if seen[alias] {
				current = nil
				continue
			}
			seen[alias] = true
			current = &SSHConfigHost{Alias: alias}
		case "match":
			flush()
			inMatch = true
			current = nil
		case "hostname":
			if current != nil && !inMatch {
				current.Host = value
			}
		case "user":
			if current != nil && !inMatch {
				current.Username = value
			}
		case "port":
			if current != nil && !inMatch {
				if n, err := strconv.Atoi(value); err == nil && n > 0 && n <= 65535 {
					current.Port = n
				}
			}
		case "identityfile":
			if current != nil && !inMatch && current.IdentityFile == "" {
				current.IdentityFile = expandHome(value)
			}
		case "proxyjump":
			if current != nil && !inMatch {
				current.ProxyJump = value
			}
		}
	}
	flush()

	return entries, nil
}

// splitSSHConfigLine 拆分 "Key Value" 或 "Key=Value" 两种写法，并去除引号。
func splitSSHConfigLine(line string) (key, value string) {
	if idx := strings.IndexAny(line, " \t="); idx >= 0 {
		key = strings.TrimSpace(line[:idx])
		value = strings.TrimSpace(line[idx+1:])
		value = strings.TrimPrefix(value, "=")
		value = strings.TrimSpace(value)
	} else {
		key = line
	}
	value = strings.Trim(value, `"'`)
	return key, value
}

// firstAliasWithoutWildcard 取 Host 行中第一个不含通配符的别名。
func firstAliasWithoutWildcard(value string) string {
	for _, alias := range strings.Fields(value) {
		if strings.ContainsAny(alias, "*?") || strings.HasPrefix(alias, "!") {
			continue
		}
		return alias
	}
	return ""
}

// expandHome 展开路径开头的 ~。
func expandHome(path string) string {
	if !strings.HasPrefix(path, "~") {
		return path
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	if path == "~" {
		return home
	}
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		return filepath.Join(home, path[2:])
	}
	return path
}
