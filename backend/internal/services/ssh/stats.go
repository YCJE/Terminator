package ssh

import (
	"math"
	"strconv"
	"strings"
	"time"
)

// maxProcBytes 是 /proc 数值乘以 1024 前的安全上限。
// meminfo/df 的数值来自远端主机，异常或恶意值乘 1024 会溢出 int64
// （变成负数），使界面显示负的内存/磁盘占用。
const maxProcBytes = math.MaxInt64 / 1024

// SystemStats 是远端主机的一条轻量资源采样结果。
// 仅支持 Linux（依赖 /proc 与 df），其他系统返回 Supported=false。
type SystemStats struct {
	Supported     bool    `json:"supported"`
	OS            string  `json:"os"`
	Load1         float64 `json:"load1"`
	Load5         float64 `json:"load5"`
	Load15        float64 `json:"load15"`
	CPUCount      int     `json:"cpuCount"`
	MemUsed       int64   `json:"memUsed"`  // 字节
	MemTotal      int64   `json:"memTotal"` // 字节
	SwapUsed      int64   `json:"swapUsed"`
	SwapTotal     int64   `json:"swapTotal"`
	DiskUsed      int64   `json:"diskUsed"`
	DiskTotal     int64   `json:"diskTotal"`
	UptimeSeconds int64   `json:"uptimeSeconds"`
}

// statsCommand 用标记分隔各段输出，避免不同系统的命令输出格式差异导致错位。
const statsCommand = `LC_ALL=C sh -c 'echo @@os; uname -s; echo @@load; cut -d" " -f1-3 /proc/loadavg; echo @@cpu; getconf _NPROCESSORS_ONLN 2>/dev/null || nproc; echo @@mem; awk "/MemTotal/{t=\$2} /MemAvailable/{a=\$2} /SwapTotal/{st=\$2} /SwapFree/{sf=\$2} END{print t\" \"a\" \"st\" \"sf}" /proc/meminfo; echo @@disk; df -Pk / | tail -n 1; echo @@uptime; cut -d. -f1 /proc/uptime'`

// GetSystemStats 在指定会话的连接上执行一次轻量采样，返回 CPU 负载、
// 内存、根分区占用与运行时长。使用独立 exec 会话，不干扰交互式 shell。
func (s *SshService) GetSystemStats(sessionID string) (*SystemStats, error) {
	out, err := s.ExecCommand(sessionID, statsCommand, 4*time.Second)
	if err != nil && strings.TrimSpace(out) == "" {
		return nil, err
	}
	return parseSystemStats(out), nil
}

func parseSystemStats(output string) *SystemStats {
	stats := &SystemStats{}
	section := ""

	for _, raw := range strings.Split(output, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "@@") {
			section = strings.TrimPrefix(line, "@@")
			continue
		}
		switch section {
		case "os":
			stats.OS = line
		case "load":
			fields := strings.Fields(line)
			if len(fields) >= 3 {
				if v, err := strconv.ParseFloat(fields[0], 64); err == nil {
					stats.Load1 = v
				}
				if v, err := strconv.ParseFloat(fields[1], 64); err == nil {
					stats.Load5 = v
				}
				if v, err := strconv.ParseFloat(fields[2], 64); err == nil {
					stats.Load15 = v
				}
			} else if v, err := strconv.ParseFloat(line, 64); err == nil {
				stats.Load1 = v
			}
		case "cpu":
			if v, err := strconv.Atoi(line); err == nil && v > 0 {
				stats.CPUCount = v
			}
		case "mem":
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				total, errT := strconv.ParseInt(fields[0], 10, 64)
				avail, errA := strconv.ParseInt(fields[1], 10, 64)
				if errT == nil && errA == nil && total > 0 && total <= maxProcBytes {
					stats.MemTotal = total * 1024
					used := total - avail
					if used < 0 {
						used = 0
					}
					stats.MemUsed = used * 1024
				}
			}
			// 后两段为 SwapTotal / SwapFree（部分精简系统可能没有）
			if len(fields) >= 4 {
				swapTotal, errT := strconv.ParseInt(fields[2], 10, 64)
				swapFree, errF := strconv.ParseInt(fields[3], 10, 64)
				if errT == nil && errF == nil && swapTotal > 0 && swapTotal <= maxProcBytes {
					stats.SwapTotal = swapTotal * 1024
					used := swapTotal - swapFree
					if used < 0 {
						used = 0
					}
					stats.SwapUsed = used * 1024
				}
			}
		case "disk":
			fields := strings.Fields(line)
			// df -Pk 输出：Filesystem 1024-blocks Used Available Capacity Mounted
			if len(fields) >= 3 {
				total, errT := strconv.ParseInt(fields[1], 10, 64)
				used, errU := strconv.ParseInt(fields[2], 10, 64)
				// Used 也可能被异常值放大，两个字段都要做溢出保护
				if errT == nil && errU == nil && total > 0 && total <= maxProcBytes &&
					used >= 0 && used <= maxProcBytes {
					stats.DiskTotal = total * 1024
					stats.DiskUsed = used * 1024
				}
			}
		case "uptime":
			if v, err := strconv.ParseInt(line, 10, 64); err == nil {
				stats.UptimeSeconds = v
			}
		}
	}

	stats.Supported = stats.MemTotal > 0
	return stats
}
