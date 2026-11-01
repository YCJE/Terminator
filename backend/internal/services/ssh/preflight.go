package ssh

import (
	"fmt"
	"strings"
	"time"

	"terminator-desktop/backend/internal/services/charset"
)

// ConnectionTestStep 描述连接预检中的一个阶段。
// Key 是稳定标识，由前端负责本地化；Detail 仅在失败时给出具体原因。
type ConnectionTestStep struct {
	Key        string `json:"key"`
	OK         bool   `json:"ok"`
	DurationMS int64  `json:"durationMs"`
	Detail     string `json:"detail,omitempty"`
}

// ConnectionTestResult 是连接预检的完整结果。
// 即使失败也返回结果对象而不是 Go error，使前端能逐阶段展示失败位置。
type ConnectionTestResult struct {
	OK    bool                 `json:"ok"`
	Steps []ConnectionTestStep `json:"steps"`
	Error string               `json:"error,omitempty"`
}

// TestConnection 对主机配置做一次真实但短暂的连接预检：
// 校验配置 → 建立 SSH 连接（含代理/跳板/host key 校验/认证）→ 打开会话通道。
//
// 预检不使用连接池，结束后立即关闭；不会留下监听端口或后台会话。
// 首次连接仍会按 TOFU 写入 known_hosts，与正常连接的行为一致。
func (s *SshService) TestConnection(config *SSHConnectionConfig) *ConnectionTestResult {
	result := &ConnectionTestResult{Steps: make([]ConnectionTestStep, 0, 3)}
	fail := func(key string, start time.Time, err error) *ConnectionTestResult {
		result.OK = false
		result.Error = err.Error()
		result.Steps = append(result.Steps, ConnectionTestStep{
			Key:        key,
			OK:         false,
			DurationMS: time.Since(start).Milliseconds(),
			Detail:     err.Error(),
		})
		return result
	}

	start := time.Now()
	if config == nil {
		return fail("config", start, fmt.Errorf("连接配置为空"))
	}
	if strings.TrimSpace(config.Host) == "" {
		return fail("config", start, fmt.Errorf("主机地址不能为空"))
	}
	if config.Port <= 0 || config.Port > 65535 {
		return fail("config", start, fmt.Errorf("SSH 端口必须在 1-65535 之间"))
	}
	if strings.TrimSpace(config.Username) == "" {
		return fail("config", start, fmt.Errorf("用户名不能为空"))
	}
	if _, err := charset.Parse(config.Encoding); err != nil {
		return fail("config", start, err)
	}
	result.Steps = append(result.Steps, ConnectionTestStep{
		Key:        "config",
		OK:         true,
		DurationMS: time.Since(start).Milliseconds(),
		Detail:     fmt.Sprintf("%s@%s:%d", config.Username, config.Host, config.Port),
	})

	start = time.Now()
	client, err := s.dialSSH(config)
	if err != nil {
		return fail("transport", start, err)
	}
	result.Steps = append(result.Steps, ConnectionTestStep{
		Key:        "transport",
		OK:         true,
		DurationMS: time.Since(start).Milliseconds(),
	})
	defer client.Close()

	start = time.Now()
	session, err := client.NewSession()
	if err != nil {
		return fail("session", start, fmt.Errorf("SSH 会话通道创建失败: %w", err))
	}
	_ = session.Close()
	result.Steps = append(result.Steps, ConnectionTestStep{
		Key:        "session",
		OK:         true,
		DurationMS: time.Since(start).Milliseconds(),
	})

	result.OK = true
	return result
}
