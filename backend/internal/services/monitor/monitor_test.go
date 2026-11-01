package monitor

import (
	"errors"
	"sync"
	"testing"
	"time"
)

const sampleOutput = `@@host
test-host
@@kernel
5.15.0-91-generic
@@os
"Ubuntu 22.04.3 LTS"
@@uptime
123456
@@load
0.50 0.40 0.30
@@cpu
cpu  100 0 50 2000 10 0 0 0
cpu0 50 0 25 1000 5 0 0 0
cpu1 50 0 25 1000 5 0 0 0
@@mem
16384 2048 8192 512 4096 1024 0
@@net
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    eth0: 123456 789 1 0 0 0 0 0 234567 890 2 0 0 0 0 0
@@disk
   8       0 sda 100 0 2048 0 200 0 4096 0 0 0 0
   8       1 sda1 50 0 1024 0 100 0 2048 0 0 0 0
   8      16 sdb 10 0 128 0 20 0 256 0 0 0 0
@@df
/dev/sda1 102400 51200 51200 50% /
tmpfs 8192000 0 8192000 0% /dev/shm
@@ps
  123 root 12.5 3.1 10240 01:02:03 java -jar app.jar
  456 www 5.0 1.0 4096 00:10 my-server --port 8080
@@psmem
  789 mysql 0.5 25.0 500000 10:00:00 mysqld
  123 root 12.5 3.1 10240 01:02:03 java -jar app.jar
@@tcp
01 12
06 5
@@proc
120
@@users
2
@@nproc
2
@@end`

func TestParseProbe(t *testing.T) {
	raw := parseProbe(sampleOutput)

	if raw.hostname != "test-host" {
		t.Fatalf("hostname = %q", raw.hostname)
	}
	if raw.os != "Ubuntu 22.04.3 LTS" {
		t.Fatalf("os 应去掉引号: %q", raw.os)
	}
	if raw.uptime != 123456 {
		t.Fatalf("uptime = %d", raw.uptime)
	}
	if raw.load1 != 0.5 || raw.load5 != 0.4 || raw.load15 != 0.3 {
		t.Fatalf("load 解析错误: %v %v %v", raw.load1, raw.load5, raw.load15)
	}
	if !raw.hasProc {
		t.Fatal("读取到 meminfo 时应标记为 supported")
	}

	wantTotal := int64(16384) * 1024
	if raw.mem.Total != wantTotal {
		t.Fatalf("mem.Total = %d, want %d", raw.mem.Total, wantTotal)
	}
	if raw.mem.Used != int64(16384-8192)*1024 {
		t.Fatalf("mem.Used = %d", raw.mem.Used)
	}
	if raw.mem.SwapUsed != int64(1024)*1024 {
		t.Fatalf("swap 已用计算错误: %d", raw.mem.SwapUsed)
	}

	eth0 := raw.net["eth0"]
	if eth0.rxBytes != 123456 || eth0.txBytes != 234567 {
		t.Fatalf("网卡累计值错误: %+v", eth0)
	}
	if eth0.rxErrors != 1 || eth0.txErrors != 2 {
		t.Fatalf("网卡错误计数错误: %+v", eth0)
	}

	// 分区 sda1 必须被过滤，只保留 sda / sdb
	if _, ok := raw.disk["sda1"]; ok {
		t.Fatal("分区 sda1 不应出现在磁盘列表")
	}
	sda := raw.disk["sda"]
	if sda.readBytes != 2048*512 || sda.writeBytes != 4096*512 {
		t.Fatalf("磁盘字节换算错误: %+v", sda)
	}
	if len(raw.disk) != 2 {
		t.Fatalf("应保留 2 个块设备，实际 %d", len(raw.disk))
	}

	if len(raw.processes) != 3 {
		t.Fatalf("进程条数（CPU Top 与内存 Top 合并）= %d", len(raw.processes))
	}
	if raw.processes[0].Command != "java -jar app.jar" {
		t.Fatalf("进程命令解析错误: %q", raw.processes[0].Command)
	}
	if raw.processes[0].RSS != 10240*1024 {
		t.Fatalf("RSS 换算错误: %d", raw.processes[0].RSS)
	}
	// 只出现在内存 Top 的进程也必须保留
	if raw.processes[2].PID != 789 || raw.processes[2].Mem != 25 {
		t.Fatalf("内存 Top 进程缺失或排序错误: %+v", raw.processes[2])
	}

	// 磁盘容量：只保留真实挂载点，tmpfs 必须被过滤
	if len(raw.filesystems) != 1 {
		t.Fatalf("文件系统条数 = %d, want 1: %+v", len(raw.filesystems), raw.filesystems)
	}
	fs := raw.filesystems[0]
	if fs.Mount != "/" || fs.Total != 102400*1024 || fs.Used != 51200*1024 {
		t.Fatalf("文件系统解析错误: %+v", fs)
	}
	if fs.UsagePercent < 49.9 || fs.UsagePercent > 50.1 {
		t.Fatalf("使用率 = %v, want 50", fs.UsagePercent)
	}

	// TCP 状态：十六进制转名称并按数量降序
	if len(raw.tcpStates) != 2 || raw.tcpStates[0].State != "ESTABLISHED" || raw.tcpStates[0].Count != 12 {
		t.Fatalf("TCP 状态解析错误: %+v", raw.tcpStates)
	}
	if raw.tcpStates[1].State != "TIME_WAIT" || raw.tcpStates[1].Count != 5 {
		t.Fatalf("TCP 状态排序错误: %+v", raw.tcpStates)
	}

	if raw.procCount != 119 {
		t.Fatalf("进程总数应去掉表头: %d", raw.procCount)
	}
	if raw.users != 2 || raw.nproc != 2 {
		t.Fatalf("users/nproc = %d/%d", raw.users, raw.nproc)
	}
}

func TestBuildSampleCPUUsage(t *testing.T) {
	state := &sessionState{}
	first := parseProbe(sampleOutput)

	// 首帧没有基线：CPU 使用率应为 0，但基础信息已经可用
	firstSample := state.buildSample("s1", first, time.Second)
	if firstSample.CPU.Usage != 0 {
		t.Fatalf("首帧不应有 CPU 使用率: %v", firstSample.CPU.Usage)
	}
	if firstSample.System.Hostname != "test-host" || firstSample.System.CPUCount != 2 {
		t.Fatalf("系统信息错误: %+v", firstSample.System)
	}

	// 第二帧：总计数 +1000，空闲 +850，用户态 +100，系统态 +50
	second := parseProbe(`@@cpu
cpu 200 0 100 2850 10 0 0 0
cpu0 100 0 50 1425 5 0 0 0
cpu1 100 0 50 1425 5 0 0 0
@@mem
16384 2048 8192 512 4096 1024 0
@@nproc
2
@@end`)

	secondSample := state.buildSample("s1", second, time.Second)
	if diff := secondSample.CPU.Usage - 15.0; diff > 0.001 || diff < -0.001 {
		t.Fatalf("CPU usage = %v, want 15", secondSample.CPU.Usage)
	}
	if diff := secondSample.CPU.User - 10.0; diff > 0.001 || diff < -0.001 {
		t.Fatalf("user = %v, want 10", secondSample.CPU.User)
	}
	if diff := secondSample.CPU.System - 5.0; diff > 0.001 || diff < -0.001 {
		t.Fatalf("system = %v, want 5", secondSample.CPU.System)
	}
	if len(secondSample.CPU.PerCore) != 2 {
		t.Fatalf("每核数据条数 = %d", len(secondSample.CPU.PerCore))
	}
	if secondSample.CPU.PerCore[0] != secondSample.CPU.PerCore[1] {
		t.Fatalf("两核使用率应一致: %v", secondSample.CPU.PerCore)
	}
}

// 网络包速率与丢包计数：第二帧差分后应得到每秒包数，并保留累计丢包。
func TestBuildSampleNetworkRates(t *testing.T) {
	state := &sessionState{}
	first := parseProbe(sampleOutput)
	state.buildSample("s1", first, time.Second)
	// 固定一个 2 秒的时间基线，避免测试受真实调度延迟影响
	state.prev.at = time.Now().Add(-2 * time.Second)

	second := parseProbe(`@@net
    eth0: 123956 839 1 3 0 0 0 0 234967 940 2 4 0 0 0 0
@@mem
16384 2048 8192 512 4096 1024 0
@@end`)
	sample := state.buildSample("s1", second, time.Second)
	if len(sample.Network) != 1 {
		t.Fatalf("网卡条数 = %d", len(sample.Network))
	}
	eth0 := sample.Network[0]
	if eth0.Name != "eth0" {
		t.Fatalf("网卡名称 = %q", eth0.Name)
	}
	if eth0.RxBps < 249 || eth0.RxBps > 251 {
		t.Fatalf("RxBps = %v, want 250", eth0.RxBps)
	}
	if eth0.RxPps < 24.9 || eth0.RxPps > 25.1 {
		t.Fatalf("RxPps = %v, want 25", eth0.RxPps)
	}
	if eth0.RxDrops != 3 || eth0.TxDrops != 4 {
		t.Fatalf("丢包计数错误: %+v", eth0)
	}
}

func TestDiffUintHandlesCounterReset(t *testing.T) {
	if got := diffUint(1, 100); got != 0 {
		t.Fatalf("计数器回绕应返回 0，实际 %d", got)
	}
	if got := diffUint(100, 1); got != 99 {
		t.Fatalf("正常差值 = %d, want 99", got)
	}
}

func TestIsDiskPartition(t *testing.T) {
	cases := map[string]bool{
		"sda":       false,
		"sda1":      true,
		"nvme0n1":   false,
		"nvme0n1p1": true,
		"mmcblk0":   false,
		"mmcblk0p1": true,
		"loop0":     true,
		"zram0":     true,
		"dm-0":      false,
		"vda":       false,
		"vda1":      true,
		"":          true,
	}
	for name, want := range cases {
		if got := isDiskPartition(name); got != want {
			t.Errorf("isDiskPartition(%q) = %v, want %v", name, got, want)
		}
	}
}

// fakeRunner 返回固定输出或固定错误，用于验证采集生命周期。
type fakeRunner struct {
	mu     sync.Mutex
	calls  int
	output string
	err    error
}

func (f *fakeRunner) ExecCommand(_ string, _ string, _ time.Duration) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	return f.output, f.err
}

type fakeEmitter struct {
	samples chan MonitorSample
	errors  chan string
}

func newFakeEmitter() *fakeEmitter {
	return &fakeEmitter{samples: make(chan MonitorSample, 8), errors: make(chan string, 8)}
}

func (e *fakeEmitter) EmitMonitorSample(sample MonitorSample) {
	e.samples <- sample
}

func (e *fakeEmitter) EmitMonitorError(_ string, message string) {
	e.errors <- message
}

func TestMonitorServiceStartStop(t *testing.T) {
	runner := &fakeRunner{output: sampleOutput}
	emitter := newFakeEmitter()
	svc := NewMonitorService(runner, emitter)

	if err := svc.Start("s1", 500); err != nil {
		t.Fatalf("Start 失败: %v", err)
	}

	// 启动后应立即收到一帧，不必等待完整周期
	select {
	case sample := <-emitter.samples:
		if sample.SessionID != "s1" {
			t.Fatalf("sessionID = %q", sample.SessionID)
		}
		if !sample.Supported {
			t.Fatal("应标记为 supported")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("启动后未收到采样")
	}

	svc.Stop("s1")

	// 停止后不应再有新采样（500ms 周期，观察 700ms）
	select {
	case sample := <-emitter.samples:
		t.Fatalf("停止后仍收到采样: %+v", sample)
	case <-time.After(700 * time.Millisecond):
	}
}

func TestMonitorServiceStopsOnError(t *testing.T) {
	runner := &fakeRunner{err: errors.New("connection lost")}
	emitter := newFakeEmitter()
	svc := NewMonitorService(runner, emitter)

	if err := svc.Start("s1", 500); err != nil {
		t.Fatalf("Start 失败: %v", err)
	}

	select {
	case message := <-emitter.errors:
		if message == "" {
			t.Fatal("错误消息不应为空")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("未收到错误事件")
	}

	// 采集失败后循环应自行退出并从注册表移除
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		svc.mu.Lock()
		count := len(svc.sessions)
		svc.mu.Unlock()
		if count == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("采集失败后会话状态未清理")
}

func TestNormalizeInterval(t *testing.T) {
	cases := []struct {
		input int
		want  time.Duration
	}{
		{0, time.Second},
		{200, 500 * time.Millisecond},
		{1000, time.Second},
		{60000, 30 * time.Second},
	}
	for _, c := range cases {
		if got := normalizeInterval(c.input); got != c.want {
			t.Errorf("normalizeInterval(%d) = %v, want %v", c.input, got, c.want)
		}
	}
}
