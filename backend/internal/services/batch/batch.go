// Package batch 实现"在多台已连接的服务器上并发执行同一条命令"。
//
// 复用 SshService 已有的 SSH 连接，每个会话单独开一个命令通道，
// 不会打扰用户正在使用的交互式终端。结果按传入顺序返回，
// 单台失败（退出码非 0、超时、连接断开）不影响其他主机继续执行。
package batch

import (
	"strings"
	"sync"
	"time"

	"terminator-desktop/backend/internal/services/ssh"
)

// 执行参数边界
const (
	// defaultTimeoutSeconds 未指定或非法时的默认超时（秒）
	defaultTimeoutSeconds = 60
	// maxTimeoutSeconds 超时上限：批量命令通常是查看状态，过长的超时只会让界面长时间无响应
	maxTimeoutSeconds = 3600
	// maxSessions 单次批量执行允许的最大会话数，避免一次创建过多通道
	maxSessions = 200
	// outputLimitPerSession 单台主机保留的输出上限。
	// 批量结果会一次性回传前端渲染，200 台 × 默认 8MB 足以耗尽内存；
	// 截断部分会在输出末尾注明，不影响退出状态判断。
	outputLimitPerSession = 256 << 10
)

// Result 单台主机的执行结果。
type Result struct {
	SessionID  string `json:"sessionId"`
	Output     string `json:"output"`     // 标准输出与标准错误（合并）
	Success    bool   `json:"success"`    // 退出码为 0
	Error      string `json:"error"`      // 失败原因（成功时为空）
	DurationMs int64  `json:"durationMs"` // 本次执行耗时（毫秒）
}

// Service 提供批量命令执行能力，作为 Wails 服务注册。
type Service struct {
	sshSvc *ssh.SshService
}

// NewService 创建批量执行服务。
func NewService(sshSvc *ssh.SshService) *Service {
	return &Service{sshSvc: sshSvc}
}

// normalizeTimeout 把前端传入的秒数收敛到合法区间。
func normalizeTimeout(seconds int) int {
	if seconds <= 0 {
		return defaultTimeoutSeconds
	}
	if seconds > maxTimeoutSeconds {
		return maxTimeoutSeconds
	}
	return seconds
}

// uniqueSessionIDs 去掉空值与重复项，并限制总数。
func uniqueSessionIDs(ids []string) []string {
	seen := make(map[string]struct{}, len(ids))
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		clean := strings.TrimSpace(id)
		if clean == "" {
			continue
		}
		if _, ok := seen[clean]; ok {
			continue
		}
		seen[clean] = struct{}{}
		out = append(out, clean)
		if len(out) >= maxSessions {
			break
		}
	}
	return out
}

// RunOnSessions 在所有给定会话上并发执行同一条命令，返回顺序与入参一致。
// 命令为空时直接返回空结果，不做任何调用。
func (s *Service) RunOnSessions(sessionIDs []string, command string, timeoutSeconds int) []Result {
	cmd := strings.TrimSpace(command)
	targets := uniqueSessionIDs(sessionIDs)
	if cmd == "" || len(targets) == 0 {
		return []Result{}
	}

	timeout := time.Duration(normalizeTimeout(timeoutSeconds)) * time.Second
	results := make([]Result, len(targets))

	var wg sync.WaitGroup
	for index, sessionID := range targets {
		wg.Add(1)
		go func(index int, sessionID string) {
			defer wg.Done()
			started := time.Now()
			output, err := s.sshSvc.ExecCommandLimited(sessionID, cmd, timeout, outputLimitPerSession)
			result := Result{
				SessionID:  sessionID,
				Output:     output,
				Success:    err == nil,
				DurationMs: time.Since(started).Milliseconds(),
			}
			if err != nil {
				result.Error = err.Error()
			}
			results[index] = result
		}(index, sessionID)
	}
	wg.Wait()
	return results
}
