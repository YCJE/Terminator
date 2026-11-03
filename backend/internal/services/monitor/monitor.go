// Package monitor 提供远程主机的实时监控采样。
//
// 采样方式是「每次采样执行一条只读探测命令」：通过独立的 SSH exec 会话
// 读取 /proc 下的计数，再在 Go 侧对两次采样做差分得到 CPU 使用率、
// 磁盘/网络吞吐。相比在远端常驻一个监控脚本，这种方式不会留下后台进程，
// 会话断开或命令失败时采集立即停止，也不需要在远端维护状态文件。
//
// 仅支持 Linux：所有指标都依赖 /proc。其他系统返回 Supported=false，
// 前端据此展示"当前系统不支持监控"。
package monitor

import (
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// probeTimeout 单次探测命令的超时。超过后结束本次采样并停止该会话的监控，
// 避免网络黑洞时 goroutine 永久阻塞在 SSH 通道上。
const probeTimeout = 4 * time.Second

// 采样间隔边界：500ms 是远端命令执行与 SSH 建会话开销的下限，
// 30s 是用户可配置的最大间隔。
const (
	minIntervalMS     = 500
	maxIntervalMS     = 30000
	defaultIntervalMS = 1000
)

// maxProcBytes 是 /proc 计数值乘以 1024 前的安全上限，防止恶意/异常的
// 数值在换算字节时溢出 int64 变成负数。
const maxProcBytes = math.MaxInt64 / 1024

// tcpStateNames /proc/net/tcp 状态码（十六进制）到可读名称的映射。
var tcpStateNames = map[string]string{
	"01": "ESTABLISHED",
	"02": "SYN_SENT",
	"03": "SYN_RECV",
	"04": "FIN_WAIT1",
	"05": "FIN_WAIT2",
	"06": "TIME_WAIT",
	"07": "CLOSE",
	"08": "CLOSE_WAIT",
	"09": "LAST_ACK",
	"0A": "LISTEN",
	"0B": "CLOSING",
	"0C": "NEW_SYN_RECV",
}

// Emitter 向前端推送采样结果与错误。
type Emitter interface {
	EmitMonitorSample(sample MonitorSample)
	EmitMonitorError(sessionID string, message string)
}

// Runner 抽象命令执行，便于单元测试替换 SSH 依赖。
type Runner interface {
	ExecCommand(sessionID string, command string, timeout time.Duration) (string, error)
}

// CPUStats CPU 使用与负载。
type CPUStats struct {
	Usage   float64   `json:"usage"`   // 0-100，含 iowait
	PerCore []float64 `json:"perCore"` // 每个逻辑核的使用率
	User    float64   `json:"user"`
	System  float64   `json:"system"`
	Iowait  float64   `json:"iowait"`
	Load1   float64   `json:"load1"`
	Load5   float64   `json:"load5"`
	Load15  float64   `json:"load15"`
}

// MemoryStats 内存与 Swap（字节）。
type MemoryStats struct {
	Total     int64 `json:"total"`
	Used      int64 `json:"used"`
	Free      int64 `json:"free"`
	Available int64 `json:"available"`
	Buffers   int64 `json:"buffers"`
	Cached    int64 `json:"cached"`
	SwapTotal int64 `json:"swapTotal"`
	SwapUsed  int64 `json:"swapUsed"`
}

// NetworkStat 单个网卡的累计计数与瞬时速率（字节/秒、包/秒）。
type NetworkStat struct {
	Name     string  `json:"name"`
	RxBytes  int64   `json:"rxBytes"`
	TxBytes  int64   `json:"txBytes"`
	RxBps    float64 `json:"rxBps"`
	TxBps    float64 `json:"txBps"`
	RxPps    float64 `json:"rxPps"`
	TxPps    float64 `json:"txPps"`
	RxErrors int64   `json:"rxErrors"`
	TxErrors int64   `json:"txErrors"`
	RxDrops  int64   `json:"rxDrops"`
	TxDrops  int64   `json:"txDrops"`
}

// DiskStat 单个块设备的累计读写与瞬时速率。
type DiskStat struct {
	Name       string  `json:"name"`
	ReadBytes  int64   `json:"readBytes"`
	WriteBytes int64   `json:"writeBytes"`
	ReadBps    float64 `json:"readBps"`
	WriteBps   float64 `json:"writeBps"`
	IOPS       float64 `json:"iops"`
}

// FilesystemStat 单个挂载点的容量使用情况（字节）。
// 与 DiskStat 的块设备 IO 互补：前者看空间是否将满，后者看读写压力。
type FilesystemStat struct {
	Device       string  `json:"device"`
	Mount        string  `json:"mount"`
	Total        int64   `json:"total"`
	Used         int64   `json:"used"`
	Available    int64   `json:"available"`
	UsagePercent float64 `json:"usagePercent"`
}

// TCPStateStat 一种 TCP 连接状态的数量（来自 /proc/net/tcp 与 tcp6）。
type TCPStateStat struct {
	State string `json:"state"`
	Count int    `json:"count"`
}

// ProcessStat 进程 Top 列表中的一项。
type ProcessStat struct {
	PID     int     `json:"pid"`
	User    string  `json:"user"`
	CPU     float64 `json:"cpu"`
	Mem     float64 `json:"mem"`
	RSS     int64   `json:"rss"`
	Time    string  `json:"time"`
	Command string  `json:"command"`
}

// SystemInfo 主机基础信息。
type SystemInfo struct {
	Hostname  string `json:"hostname"`
	Kernel    string `json:"kernel"`
	OS        string `json:"os"`
	Uptime    int64  `json:"uptime"`
	Users     int    `json:"users"`
	Processes int    `json:"processes"`
	CPUCount  int    `json:"cpuCount"`
}

// GPUStat 单块 GPU 的利用率与显存（来自 nvidia-smi，未安装时列表为空）。
type GPUStat struct {
	Index       int     `json:"index"`
	Name        string  `json:"name"`
	Utilization float64 `json:"utilization"` // 0-100
	MemoryUsed  int64   `json:"memoryUsed"`  // 字节
	MemoryTotal int64   `json:"memoryTotal"` // 字节
	Temperature float64 `json:"temperature"` // 摄氏度，不支持时为 0
}

// MonitorSample 一次完整采样，前端按 sessionId 归档。
type MonitorSample struct {
	SessionID   string           `json:"sessionId"`
	Timestamp   int64            `json:"timestamp"` // Unix 毫秒
	IntervalMS  int              `json:"intervalMs"`
	Supported   bool             `json:"supported"`
	CPU         CPUStats         `json:"cpu"`
	Memory      MemoryStats      `json:"memory"`
	Network     []NetworkStat    `json:"network"`
	Disk        []DiskStat       `json:"disk"`
	Filesystems []FilesystemStat `json:"filesystems"`
	TCPStates   []TCPStateStat   `json:"tcpStates"`
	Processes   []ProcessStat    `json:"processes"`
	System      SystemInfo       `json:"system"`
	GPU         []GPUStat        `json:"gpu"`
}

// cpuTimes /proc/stat 单行计数。
type cpuTimes struct {
	user, nice, system, idle, iowait, irq, softirq, steal uint64
}

// netCounters 单个网卡累计计数。
type netCounters struct {
	rxBytes, txBytes, rxErrors, txErrors   uint64
	rxPackets, txPackets, rxDrops, txDrops uint64
}

// diskCounters 单个块设备累计计数。
type diskCounters struct {
	readBytes, writeBytes, reads, writes uint64
}

// probeCounters 上一次采样得到的原始计数，用于差分。
type probeCounters struct {
	cpu  map[string]cpuTimes
	net  map[string]netCounters
	disk map[string]diskCounters
	at   time.Time
}

// sessionState 一个会话的采集循环状态。
// 只在启动它的 goroutine 内读写计数，Stop 只操作 channel。
type sessionState struct {
	stopCh   chan struct{}
	doneCh   chan struct{}
	stopOnce sync.Once
	hasPrev  bool
	prev     probeCounters
}

// requestStop 幂等停止采集循环：并发的 Start/Stop 可能同时操作同一状态，
// 直接 close(stopCh) 会触发 "close of closed channel" panic。
func (state *sessionState) requestStop() {
	state.stopOnce.Do(func() {
		close(state.stopCh)
	})
}

// MonitorService 管理各会话的采集 goroutine。
type MonitorService struct {
	runner  Runner
	emitter Emitter

	mu       sync.Mutex
	sessions map[string]*sessionState
}

func NewMonitorService(runner Runner, emitter Emitter) *MonitorService {
	return &MonitorService{
		runner:   runner,
		emitter:  emitter,
		sessions: make(map[string]*sessionState),
	}
}

// Start 启动（或重启）指定会话的监控采集。
// intervalMS 会被夹到 [500, 30000]；重复调用会先停止旧循环再按新间隔启动。
func (s *MonitorService) Start(sessionID string, intervalMS int) error {
	if strings.TrimSpace(sessionID) == "" {
		return errors.New("监控会话 ID 不能为空")
	}
	interval := normalizeInterval(intervalMS)

	state := &sessionState{
		stopCh: make(chan struct{}),
		doneCh: make(chan struct{}),
	}

	// 替换与"停止旧循环"必须在同一个临界区完成：若先 stop 再注册，
	// 两个并发 Start 都可能看不到旧状态，各自启动一个采集循环；
	// 后注册者覆盖 map 后，先注册的循环再也无法被 Stop 停止。
	s.mu.Lock()
	old := s.sessions[sessionID]
	s.sessions[sessionID] = state
	s.mu.Unlock()

	if old != nil {
		old.requestStop()
		// 等待旧循环退出：若正卡在一次探测命令上，最长为 probeTimeout。
		select {
		case <-old.doneCh:
		case <-time.After(probeTimeout + time.Second):
		}
	}

	go s.run(sessionID, state, interval)
	return nil
}

// Stop 停止指定会话的监控采集。会话不存在时静默返回。
func (s *MonitorService) Stop(sessionID string) {
	s.stop(sessionID)
}

// StopAll 停止全部会话的监控（锁定/擦除数据时调用）。
func (s *MonitorService) StopAll() {
	s.mu.Lock()
	ids := make([]string, 0, len(s.sessions))
	for id := range s.sessions {
		ids = append(ids, id)
	}
	s.mu.Unlock()

	for _, id := range ids {
		s.stop(id)
	}
}

func (s *MonitorService) stop(sessionID string) {
	s.mu.Lock()
	state, ok := s.sessions[sessionID]
	if ok {
		delete(s.sessions, sessionID)
	}
	s.mu.Unlock()

	if !ok {
		return
	}
	state.requestStop()
	// 等待采集循环退出：若正卡在一次探测命令上，最长为 probeTimeout。
	select {
	case <-state.doneCh:
	case <-time.After(probeTimeout + time.Second):
	}
}

func (s *MonitorService) run(sessionID string, state *sessionState, interval time.Duration) {
	defer func() {
		// 只清理自己注册的状态：Start 重启后 map 中可能已经是新循环
		s.mu.Lock()
		if current, ok := s.sessions[sessionID]; ok && current == state {
			delete(s.sessions, sessionID)
		}
		s.mu.Unlock()
		close(state.doneCh)
	}()

	// 立即采样一次：面板打开后不必空等一个完整周期才看到数据。
	if !s.sampleOnce(sessionID, state, interval) {
		return
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-state.stopCh:
			return
		case <-ticker.C:
			if !s.sampleOnce(sessionID, state, interval) {
				return
			}
		}
	}
}

// sampleOnce 执行一次探测。返回 false 表示采集应停止（会话失效或命令超时）。
func (s *MonitorService) sampleOnce(sessionID string, state *sessionState, interval time.Duration) bool {
	out, err := s.runner.ExecCommand(sessionID, probeCommand, probeTimeout)
	if err != nil {
		message := err.Error()
		if trimmed := strings.TrimSpace(out); trimmed != "" && !strings.Contains(message, trimmed) {
			// 命令本身失败且 stderr 里有更具体的原因（如 "Permission denied"），
			// 一并带上便于前端提示，而不是只显示 "exit status 127"。
			if firstLine := firstNonMarkerLine(trimmed); firstLine != "" {
				message = fmt.Sprintf("%s: %s", message, firstLine)
			}
		}
		s.emitter.EmitMonitorError(sessionID, message)
		return false
	}

	raw := parseProbe(out)
	sample := state.buildSample(sessionID, raw, interval)
	s.emitter.EmitMonitorSample(sample)
	return true
}

func normalizeInterval(intervalMS int) time.Duration {
	if intervalMS <= 0 {
		intervalMS = defaultIntervalMS
	}
	if intervalMS < minIntervalMS {
		intervalMS = minIntervalMS
	}
	if intervalMS > maxIntervalMS {
		intervalMS = maxIntervalMS
	}
	return time.Duration(intervalMS) * time.Millisecond
}

func firstNonMarkerLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "@@") {
			continue
		}
		if len(line) > 160 {
			line = line[:160]
		}
		return line
	}
	return ""
}

// probeCommand 一次采集全部指标。
// 用 @@标记 分段，避免不同发行版命令输出的格式差异导致段落错位；
// stderr 全部丢弃，避免警告信息混进数值解析。
const probeCommand = `LC_ALL=C sh -c '
echo @@host; hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null
echo @@kernel; uname -r 2>/dev/null
echo @@os; (grep -E "^PRETTY_NAME=" /etc/os-release 2>/dev/null | head -n 1 | cut -d= -f2-) || uname -s 2>/dev/null
echo @@uptime; cut -d. -f1 /proc/uptime 2>/dev/null
echo @@load; cut -d" " -f1-3 /proc/loadavg 2>/dev/null
echo @@cpu; grep "^cpu" /proc/stat 2>/dev/null
echo @@mem; awk "/MemTotal/{t=\$2} /MemFree/{f=\$2} /MemAvailable/{a=\$2} /Buffers/{b=\$2} /^Cached/{c=\$2} /SwapTotal/{st=\$2} /SwapFree/{sf=\$2} END{print t\" \"f\" \"a\" \"b\" \"c\" \"st\" \"sf}" /proc/meminfo 2>/dev/null
echo @@net; cat /proc/net/dev 2>/dev/null
echo @@disk; cat /proc/diskstats 2>/dev/null
echo @@df; df -P -k 2>/dev/null | tail -n +2
echo @@ps; ps -eo pid,user,pcpu,pmem,rss,etime,args 2>/dev/null | tail -n +2 | sort -k3 -nr | head -n 15
echo @@psmem; ps -eo pid,user,pcpu,pmem,rss,etime,args 2>/dev/null | tail -n +2 | sort -k4 -nr | head -n 15
echo @@tcp; awk "FNR>1 {c[\$4]++} END {for (s in c) print s, c[s]}" /proc/net/tcp /proc/net/tcp6 2>/dev/null
echo @@proc; ps -e 2>/dev/null | wc -l
echo @@users; who 2>/dev/null | wc -l
echo @@nproc; getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null
echo @@gpu; timeout 1 nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>/dev/null
echo @@end
'`

// probeRaw 解析后的原始探测结果（未经差分）。
type probeRaw struct {
	hostname  string
	kernel    string
	os        string
	uptime    int64
	load1     float64
	load5     float64
	load15    float64
	cpu       map[string]cpuTimes
	mem       MemoryStats
	net       map[string]netCounters
	disk      map[string]diskCounters
	processes []ProcessStat
	// processesMem 按内存排序的进程集合。与 processes 合并后前端可切换排序，
	// 单独只取 CPU Top 会漏掉"内存占用高但不吃 CPU"的进程。
	processesMem []ProcessStat
	filesystems  []FilesystemStat
	tcpStates    []TCPStateStat
	gpu          []GPUStat
	procCount    int
	users        int
	nproc        int
	hasProc      bool
}

func parseProbe(output string) probeRaw {
	raw := probeRaw{
		cpu:  make(map[string]cpuTimes),
		net:  make(map[string]netCounters),
		disk: make(map[string]diskCounters),
	}
	section := ""

	for _, line := range strings.Split(output, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.HasPrefix(trimmed, "@@") {
			section = strings.TrimPrefix(trimmed, "@@")
			continue
		}

		switch section {
		case "host":
			raw.hostname = trimmed
		case "kernel":
			raw.kernel = trimmed
		case "os":
			raw.os = strings.Trim(trimmed, `"'`)
		case "uptime":
			if v, err := strconv.ParseInt(trimmed, 10, 64); err == nil && v >= 0 {
				raw.uptime = v
			}
		case "load":
			fields := strings.Fields(trimmed)
			if len(fields) >= 3 {
				raw.load1 = parseFloat(fields[0])
				raw.load5 = parseFloat(fields[1])
				raw.load15 = parseFloat(fields[2])
			}
		case "cpu":
			fields := strings.Fields(trimmed)
			if len(fields) < 5 || !strings.HasPrefix(fields[0], "cpu") {
				continue
			}
			name := fields[0]
			// guest/guest_nice 属于宿主侧统计，且已被 user/nice 计入，忽略
			values := make([]uint64, 8)
			for i := 0; i < 8 && i+1 < len(fields); i++ {
				values[i] = parseUint(fields[i+1])
			}
			raw.cpu[name] = cpuTimes{
				user: values[0], nice: values[1], system: values[2], idle: values[3],
				iowait: values[4], irq: values[5], softirq: values[6], steal: values[7],
			}
		case "mem":
			fields := strings.Fields(trimmed)
			if len(fields) >= 2 {
				total := parseKb(fields[0])
				free := parseKb(fields[1])
				available := free
				if len(fields) >= 3 {
					available = parseKb(fields[2])
				}
				buffers, cached := int64(0), int64(0)
				if len(fields) >= 4 {
					buffers = parseKb(fields[3])
				}
				if len(fields) >= 5 {
					cached = parseKb(fields[4])
				}
				if total > 0 {
					raw.mem.Total = total
					raw.mem.Free = free
					raw.mem.Available = available
					raw.mem.Buffers = buffers
					raw.mem.Cached = cached
					used := total - available
					if used < 0 {
						used = 0
					}
					raw.mem.Used = used
				}
				if len(fields) >= 7 {
					swapTotal := parseKb(fields[5])
					swapFree := parseKb(fields[6])
					if swapTotal > 0 {
						raw.mem.SwapTotal = swapTotal
						swapUsed := swapTotal - swapFree
						if swapUsed < 0 {
							swapUsed = 0
						}
						raw.mem.SwapUsed = swapUsed
					}
				}
				raw.hasProc = raw.mem.Total > 0
			}
		case "net":
			// /proc/net/dev 前两行是表头
			if strings.Contains(trimmed, "|") || !strings.Contains(trimmed, ":") {
				continue
			}
			idx := strings.IndexByte(trimmed, ':')
			name := strings.TrimSpace(trimmed[:idx])
			fields := strings.Fields(trimmed[idx+1:])
			if name == "" || len(fields) < 11 {
				continue
			}
			raw.net[name] = netCounters{
				rxBytes:   parseUint(fields[0]),
				rxPackets: parseUint(fields[1]),
				rxErrors:  parseUint(fields[2]),
				rxDrops:   parseUint(fields[3]),
				txBytes:   parseUint(fields[8]),
				txPackets: parseUint(fields[9]),
				txErrors:  parseUint(fields[10]),
				txDrops:   parseUint(fields[11]),
			}
		case "df":
			// df -P -k 的列固定为：文件系统 1K块 已用 可用 容量% 挂载点。
			// 挂载点可能包含空格，因此从第 6 列起整体拼接。
			fields := strings.Fields(trimmed)
			if len(fields) < 6 || isPseudoFilesystem(fields[0]) {
				continue
			}
			total := parseKb(fields[1])
			used := parseKb(fields[2])
			available := parseKb(fields[3])
			if total <= 0 {
				continue
			}
			usage := 0.0
			if used+available > 0 {
				usage = float64(used) / float64(used+available) * 100
			}
			raw.filesystems = append(raw.filesystems, FilesystemStat{
				Device:       fields[0],
				Mount:        strings.Join(fields[5:], " "),
				Total:        total,
				Used:         used,
				Available:    available,
				UsagePercent: usage,
			})
		case "disk":
			fields := strings.Fields(trimmed)
			if len(fields) < 10 {
				continue
			}
			name := fields[2]
			if isDiskPartition(name) {
				continue
			}
			readSectors := parseUint(fields[5])
			writeSectors := parseUint(fields[9])
			raw.disk[name] = diskCounters{
				reads:      parseUint(fields[3]),
				writes:     parseUint(fields[7]),
				readBytes:  sectorsToBytes(readSectors),
				writeBytes: sectorsToBytes(writeSectors),
			}
		case "ps", "psmem":
			item, ok := parseProcessLine(trimmed)
			if !ok {
				continue
			}
			if section == "ps" {
				raw.processes = append(raw.processes, item)
			} else {
				raw.processesMem = append(raw.processesMem, item)
			}
		case "tcp":
			fields := strings.Fields(trimmed)
			if len(fields) != 2 {
				continue
			}
			count, err := strconv.Atoi(fields[1])
			if err != nil || count <= 0 {
				continue
			}
			raw.tcpStates = append(raw.tcpStates, TCPStateStat{
				State: tcpStateName(fields[0]),
				Count: count,
			})
		case "proc":
			if v, err := strconv.Atoi(trimmed); err == nil && v > 0 {
				raw.procCount = v - 1 // 去掉表头
			}
		case "users":
			if v, err := strconv.Atoi(trimmed); err == nil && v >= 0 {
				raw.users = v
			}
		case "nproc":
			if v, err := strconv.Atoi(trimmed); err == nil && v > 0 {
				raw.nproc = v
			}
		case "gpu":
			if stat, ok := parseGPULine(trimmed); ok {
				raw.gpu = append(raw.gpu, stat)
			}
		}
	}
	raw.processes = mergeProcesses(raw.processes, raw.processesMem)
	sortFilesystems(raw.filesystems)
	raw.tcpStates = aggregateTCPStates(raw.tcpStates)
	return raw
}

// parseProcessLine 解析 ps -eo pid,user,pcpu,pmem,rss,etime,args 的一行。
func parseProcessLine(line string) (ProcessStat, bool) {
	fields := strings.Fields(line)
	if len(fields) < 6 {
		return ProcessStat{}, false
	}
	pid, err := strconv.Atoi(fields[0])
	if err != nil || pid <= 0 {
		return ProcessStat{}, false
	}
	command := strings.Join(fields[6:], " ")
	if len(command) > 160 {
		command = command[:160]
	}
	return ProcessStat{
		PID:     pid,
		User:    fields[1],
		CPU:     parseFloat(fields[2]),
		Mem:     parseFloat(fields[3]),
		RSS:     parseKb(fields[4]),
		Time:    fields[5],
		Command: command,
	}, true
}

// parseGPULine 解析一行 nvidia-smi CSV 输出：
// index, name, utilization.gpu, memory.used(MiB), memory.total(MiB), temperature.gpu。
func parseGPULine(line string) (GPUStat, bool) {
	fields := strings.Split(line, ",")
	if len(fields) < 6 {
		return GPUStat{}, false
	}
	index, err := strconv.Atoi(strings.TrimSpace(fields[0]))
	if err != nil || index < 0 {
		return GPUStat{}, false
	}
	name := strings.TrimSpace(fields[1])
	if name == "" {
		name = fmt.Sprintf("GPU %d", index)
	}
	return GPUStat{
		Index:       index,
		Name:        name,
		Utilization: parseFloat(strings.TrimSpace(fields[2])),
		MemoryUsed:  parseMib(fields[3]),
		MemoryTotal: parseMib(fields[4]),
		Temperature: parseFloat(strings.TrimSpace(fields[5])),
	}, true
}

// parseMib 把 MiB 数换算成字节并做溢出保护；nvidia-smi 的 [N/A] 等非数字返回 0。
func parseMib(s string) int64 {
	v, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil || v <= 0 || v > maxProcBytes/(1<<10) {
		return 0
	}
	return v << 20
}

// mergeProcesses 合并按 CPU 与按内存排序的两份 Top 列表。
// 只保留 CPU Top 会漏掉内存大户，只保留内存 Top 会漏掉 CPU 大户；
// 合并后按 CPU 降序，前端再按用户选择的指标重新排序。
func mergeProcesses(byCPU, byMem []ProcessStat) []ProcessStat {
	if len(byMem) == 0 {
		return byCPU
	}
	seen := make(map[int]struct{}, len(byCPU)+len(byMem))
	merged := make([]ProcessStat, 0, len(byCPU)+len(byMem))
	for _, item := range append(append([]ProcessStat{}, byCPU...), byMem...) {
		if _, ok := seen[item.PID]; ok {
			continue
		}
		seen[item.PID] = struct{}{}
		merged = append(merged, item)
	}
	sort.SliceStable(merged, func(i, j int) bool {
		if merged[i].CPU != merged[j].CPU {
			return merged[i].CPU > merged[j].CPU
		}
		return merged[i].Mem > merged[j].Mem
	})
	// 两份 Top 合并后最多 30 条，留一点余量给前端排序，同时限制事件载荷大小
	if len(merged) > 24 {
		merged = merged[:24]
	}
	return merged
}

// isPseudoFilesystem 过滤 tmpfs/proc 等伪文件系统，只保留真实存储挂载点。
func isPseudoFilesystem(device string) bool {
	lower := strings.ToLower(device)
	for _, prefix := range []string{
		"tmpfs", "devtmpfs", "udev", "none", "proc", "sysfs", "cgroup",
		"ramfs", "rootfs", "squashfs", "shm",
	} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	return false
}

// sortFilesystems 按挂载点排序，保证同一套挂载在不同采样间行序稳定。
func sortFilesystems(items []FilesystemStat) {
	sort.Slice(items, func(i, j int) bool {
		if items[i].Mount == items[j].Mount {
			return items[i].Device < items[j].Device
		}
		return items[i].Mount < items[j].Mount
	})
}

// tcpStateName 把 /proc/net/tcp 的十六进制状态码转成可读名称。
func tcpStateName(code string) string {
	normalized := strings.ToUpper(strings.TrimSpace(code))
	if len(normalized) == 1 {
		normalized = "0" + normalized
	}
	if name, ok := tcpStateNames[normalized]; ok {
		return name
	}
	return "STATE_" + normalized
}

// aggregateTCPStates 合并 tcp 与 tcp6 中相同状态的计数，按数量降序输出。
func aggregateTCPStates(items []TCPStateStat) []TCPStateStat {
	if len(items) == 0 {
		return nil
	}
	counts := make(map[string]int, len(items))
	for _, item := range items {
		counts[item.State] += item.Count
	}
	merged := make([]TCPStateStat, 0, len(counts))
	for state, count := range counts {
		merged = append(merged, TCPStateStat{State: state, Count: count})
	}
	sort.Slice(merged, func(i, j int) bool {
		if merged[i].Count == merged[j].Count {
			return merged[i].State < merged[j].State
		}
		return merged[i].Count > merged[j].Count
	})
	return merged
}

// buildSample 用上一次计数做差分，填充速率类指标。
func (state *sessionState) buildSample(sessionID string, raw probeRaw, interval time.Duration) MonitorSample {
	now := time.Now()
	sample := MonitorSample{
		SessionID:   sessionID,
		Timestamp:   now.UnixMilli(),
		IntervalMS:  int(interval / time.Millisecond),
		Supported:   raw.hasProc,
		Memory:      raw.mem,
		Processes:   raw.processes,
		Filesystems: raw.filesystems,
		TCPStates:   raw.tcpStates,
		GPU:         raw.gpu,
		System: SystemInfo{
			Hostname:  raw.hostname,
			Kernel:    raw.kernel,
			OS:        raw.os,
			Uptime:    raw.uptime,
			Users:     raw.users,
			Processes: raw.procCount,
			CPUCount:  raw.nproc,
		},
	}
	if sample.System.CPUCount <= 0 {
		sample.System.CPUCount = len(raw.cpu) - 1
	}
	if sample.System.CPUCount < 0 {
		sample.System.CPUCount = 0
	}

	// 首次采样没有基线：CPU/磁盘/网络速率留 0，下个周期即可显示真实值
	hasPrev := state.hasPrev
	prev := state.prev
	elapsed := 0.0
	if hasPrev {
		elapsed = now.Sub(prev.at).Seconds()
		if elapsed < 0.2 {
			// 两次采样过近会导致速率被放大得极不真实，按最小间隔计算
			elapsed = 0.2
		}
	}

	sample.CPU = buildCPU(raw.cpu, prev.cpu, hasPrev, raw.load1, raw.load5, raw.load15)

	if len(raw.net) > 0 {
		sample.Network = make([]NetworkStat, 0, len(raw.net))
		for name, current := range raw.net {
			item := NetworkStat{
				Name:     name,
				RxBytes:  int64(current.rxBytes),
				TxBytes:  int64(current.txBytes),
				RxErrors: int64(current.rxErrors),
				TxErrors: int64(current.txErrors),
				RxDrops:  int64(current.rxDrops),
				TxDrops:  int64(current.txDrops),
			}
			if hasPrev {
				if before, ok := prev.net[name]; ok {
					item.RxBps = rate(current.rxBytes, before.rxBytes, elapsed)
					item.TxBps = rate(current.txBytes, before.txBytes, elapsed)
					item.RxPps = rate(current.rxPackets, before.rxPackets, elapsed)
					item.TxPps = rate(current.txPackets, before.txPackets, elapsed)
				}
			}
			sample.Network = append(sample.Network, item)
		}
		sortNetwork(sample.Network)
	}

	if len(raw.disk) > 0 {
		sample.Disk = make([]DiskStat, 0, len(raw.disk))
		for name, current := range raw.disk {
			item := DiskStat{
				Name:       name,
				ReadBytes:  int64(current.readBytes),
				WriteBytes: int64(current.writeBytes),
			}
			if hasPrev {
				if before, ok := prev.disk[name]; ok {
					item.ReadBps = rate(current.readBytes, before.readBytes, elapsed)
					item.WriteBps = rate(current.writeBytes, before.writeBytes, elapsed)
					ops := rate(current.reads+current.writes, before.reads+before.writes, elapsed)
					item.IOPS = ops
				}
			}
			sample.Disk = append(sample.Disk, item)
		}
		sortDisk(sample.Disk)
	}

	state.prev = probeCounters{cpu: raw.cpu, net: raw.net, disk: raw.disk, at: now}
	state.hasPrev = true
	return sample
}

func buildCPU(current map[string]cpuTimes, previous map[string]cpuTimes, hasPrev bool, load1, load5, load15 float64) CPUStats {
	stats := CPUStats{Load1: load1, Load5: load5, Load15: load15}
	if !hasPrev {
		return stats
	}
	total, ok := current["cpu"]
	if !ok {
		return stats
	}
	beforeTotal, ok := previous["cpu"]
	if !ok {
		return stats
	}

	d := diffCPU(total, beforeTotal)
	if d.total == 0 {
		return stats
	}
	stats.Usage = percent(d.total-d.idle, d.total)
	stats.User = percent(d.user+d.nice, d.total)
	stats.System = percent(d.system+d.irq+d.softirq, d.total)
	stats.Iowait = percent(d.iowait, d.total)

	// 每个逻辑核独立计算；核数可能因 CPU 热插拔变化，只比较两边都存在的核。
	// 按 cpuN 的数字顺序输出，前端绘制每核柱状图时不会出现乱序。
	names := make([]string, 0, len(current))
	for name := range current {
		if name == "cpu" {
			continue
		}
		if _, ok := previous[name]; ok {
			names = append(names, name)
		}
	}
	sort.Slice(names, func(i, j int) bool {
		return coreIndex(names[i]) < coreIndex(names[j])
	})
	for _, name := range names {
		coreDelta := diffCPU(current[name], previous[name])
		if coreDelta.total == 0 {
			stats.PerCore = append(stats.PerCore, 0)
			continue
		}
		stats.PerCore = append(stats.PerCore, percent(coreDelta.total-coreDelta.idle, coreDelta.total))
	}
	return stats
}

// coreIndex 取 cpuN 中的 N；解析失败时排到最后。
func coreIndex(name string) int {
	v, err := strconv.Atoi(strings.TrimPrefix(name, "cpu"))
	if err != nil {
		return math.MaxInt
	}
	return v
}

type cpuDelta struct {
	user, nice, system, idle, iowait, irq, softirq, total uint64
}

func diffCPU(current, previous cpuTimes) cpuDelta {
	d := cpuDelta{
		user:    diffUint(current.user, previous.user),
		nice:    diffUint(current.nice, previous.nice),
		system:  diffUint(current.system, previous.system),
		idle:    diffUint(current.idle, previous.idle),
		iowait:  diffUint(current.iowait, previous.iowait),
		irq:     diffUint(current.irq, previous.irq),
		softirq: diffUint(current.softirq, previous.softirq),
	}
	// total 用各字段差值相加，而不是 total()-total()：后者在计数器回绕时
	// 会下溢成巨大的 uint64，让使用率瞬间跳到异常值。
	d.total = d.user + d.nice + d.system + d.idle + d.iowait + d.irq + d.softirq +
		diffUint(current.steal, previous.steal)
	return d
}

// diffUint 计数器回绕（如远端重启）时返回 0，避免负差值变成巨大正数。
func diffUint(current, previous uint64) uint64 {
	if current < previous {
		return 0
	}
	return current - previous
}

func percent(part, total uint64) float64 {
	if total == 0 {
		return 0
	}
	return float64(part) / float64(total) * 100
}

// rate 计算两次累计计数之间的每秒速率；计数器回绕或设备重建时返回 0。
func rate(current, previous uint64, elapsedSeconds float64) float64 {
	if elapsedSeconds <= 0 || current < previous {
		return 0
	}
	return float64(current-previous) / elapsedSeconds
}

func parseUint(s string) uint64 {
	v, err := strconv.ParseUint(s, 10, 64)
	if err != nil {
		return 0
	}
	return v
}

func parseFloat(s string) float64 {
	// meminfo/ps 中可能出现逗号小数分隔（部分本地化环境），统一替换
	v, err := strconv.ParseFloat(strings.ReplaceAll(s, ",", "."), 64)
	if err != nil {
		return 0
	}
	return v
}

// parseKb 把 KB 数换算成字节，并做溢出保护。
func parseKb(s string) int64 {
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil || v <= 0 || v > maxProcBytes {
		return 0
	}
	return v * 1024
}

// sectorsToBytes /proc/diskstats 的扇区单位固定为 512 字节。
func sectorsToBytes(sectors uint64) uint64 {
	if sectors > math.MaxInt64/512 {
		return 0
	}
	return sectors * 512
}

// isDiskPartition 过滤分区与虚拟设备，避免面板里出现同一块盘的多个分区。
// 规则：loop/ram 设备忽略；nvme/mmcblk 以 p<数字> 结尾的是分区；
// 其余设备名以数字结尾的通常是分区（sda1、vda1、hda1）。
func isDiskPartition(name string) bool {
	if name == "" {
		return true
	}
	if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") || strings.HasPrefix(name, "zram") {
		return true
	}
	// dm-N 是 LVM/设备映射的顶层逻辑卷，属于可用设备而不是分区
	if strings.HasPrefix(name, "dm-") {
		return false
	}
	if strings.HasPrefix(name, "nvme") || strings.HasPrefix(name, "mmcblk") {
		idx := strings.LastIndexByte(name, 'p')
		if idx <= 0 {
			return false
		}
		return allDigits(name[idx+1:])
	}
	last := name[len(name)-1]
	return last >= '0' && last <= '9'
}

func allDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func sortNetwork(items []NetworkStat) {
	// 按当前速率降序：面板顶部展示最活跃的网卡，而不是长期累计最大的网卡。
	// 速率相同时按名称排序，保证空闲网卡的行序在每次采样间保持稳定。
	sort.Slice(items, func(i, j int) bool {
		a := items[i].RxBps + items[i].TxBps
		b := items[j].RxBps + items[j].TxBps
		if a == b {
			return items[i].Name < items[j].Name
		}
		return a > b
	})
}

func sortDisk(items []DiskStat) {
	sort.Slice(items, func(i, j int) bool {
		a := items[i].ReadBps + items[i].WriteBps
		b := items[j].ReadBps + items[j].WriteBps
		if a == b {
			return items[i].Name < items[j].Name
		}
		return a > b
	})
}

// allowedKillSignals 允许通过面板发送的信号白名单。
// 只接受常见信号名，避免把任意字符串拼进远端命令。
var allowedKillSignals = map[string]struct{}{
	"TERM": {}, "KILL": {}, "HUP": {}, "INT": {},
}

// killCommand 构造终止进程的命令。
// pid 必须是正整数且大于 1：kill PID 1 会让远端失去 init，属于不可恢复的破坏。
func killCommand(pid int, signal string) (string, error) {
	if pid <= 1 {
		return "", errors.New("拒绝终止 PID 为 1 的进程")
	}
	sig := strings.ToUpper(strings.TrimSpace(signal))
	if sig == "" {
		sig = "TERM"
	}
	if _, ok := allowedKillSignals[sig]; !ok {
		return "", fmt.Errorf("不支持的信号 %q（可选 TERM/KILL/HUP/INT）", signal)
	}
	return fmt.Sprintf("kill -%s %d", sig, pid), nil
}

// KillProcess 向远端进程发送终止信号，默认 TERM（优雅退出），KILL 用于强杀。
// 失败时把远端 stderr 原文带回前端，便于区分"进程不存在"与"权限不足"。
func (s *MonitorService) KillProcess(sessionID string, pid int, signal string) error {
	command, err := killCommand(pid, signal)
	if err != nil {
		return err
	}
	out, err := s.runner.ExecCommand(sessionID, command, probeTimeout)
	if err != nil {
		detail := strings.TrimSpace(out)
		if detail == "" {
			detail = err.Error()
		}
		return fmt.Errorf("终止进程 %d 失败: %s", pid, detail)
	}
	return nil
}
