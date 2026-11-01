package monitor

import (
	"strconv"
	"testing"
)

func TestParseGPULine(t *testing.T) {
	line := "0, NVIDIA GeForce RTX 4090, 45, 1024, 24564, 55"
	stat, ok := parseGPULine(line)
	if !ok {
		t.Fatalf("解析失败: %q", line)
	}
	if stat.Index != 0 || stat.Utilization != 45 {
		t.Errorf("基础字段解析错误: %+v", stat)
	}
	if stat.Name != "NVIDIA GeForce RTX 4090" {
		t.Errorf("名称 = %q", stat.Name)
	}
	if stat.MemoryUsed != 1024<<20 || stat.MemoryTotal != 24564<<20 {
		t.Errorf("显存换算错误: %d / %d", stat.MemoryUsed, stat.MemoryTotal)
	}
	if stat.Temperature != 55 {
		t.Errorf("温度 = %v", stat.Temperature)
	}

	// 部分字段不可用时 nvidia-smi 输出 [N/A]/[Not Supported]，应归零而不是解析失败
	unsupported := "1, Tesla T4, 0, [N/A], 15360, [Not Supported]"
	stat, ok = parseGPULine(unsupported)
	if !ok {
		t.Fatalf("含 [N/A] 的行应仍可解析: %q", unsupported)
	}
	if stat.MemoryUsed != 0 || stat.Temperature != 0 {
		t.Errorf("不可用字段应归零: %+v", stat)
	}

	for _, bad := range []string{"", "0, GPU", "abc, GPU, 10, 1, 1, 1"} {
		if _, ok := parseGPULine(bad); ok {
			t.Errorf("非法行不应解析成功: %q", bad)
		}
	}
}

func TestParseMibOverflowGuard(t *testing.T) {
	if got := parseMib("1024"); got != 1024<<20 {
		t.Errorf("1024 MiB = %d，期望 %d", got, int64(1024)<<20)
	}
	if got := parseMib("-1"); got != 0 {
		t.Errorf("负数应返回 0，实际 %d", got)
	}
	// 超过 int64 可表示的 MiB 上限（MaxInt64 >> 20）时应归零，避免移位溢出成负数
	if got := parseMib("999999999999999999"); got != 0 {
		t.Errorf("溢出应返回 0，实际 %d", got)
	}
	if got := parseMib(strconv.FormatInt(maxProcBytes/(1<<10)+1, 10)); got != 0 {
		t.Errorf("超出上限 1 应返回 0，实际 %d", got)
	}
}

func TestKillCommand(t *testing.T) {
	cases := []struct {
		pid    int
		signal string
		want   string
	}{
		{1234, "", "kill -TERM 1234"},
		{1234, "term", "kill -TERM 1234"},
		{1234, "kill", "kill -KILL 1234"},
	}
	for _, item := range cases {
		got, err := killCommand(item.pid, item.signal)
		if err != nil {
			t.Fatalf("killCommand(%d,%q) 返回错误: %v", item.pid, item.signal, err)
		}
		if got != item.want {
			t.Errorf("killCommand(%d,%q) = %q，期望 %q", item.pid, item.signal, got, item.want)
		}
	}

	if _, err := killCommand(1, "TERM"); err == nil {
		t.Error("PID 1 应被拒绝")
	}
	if _, err := killCommand(0, "TERM"); err == nil {
		t.Error("PID 0 应被拒绝")
	}
	if _, err := killCommand(1234, "SEGV"); err == nil {
		t.Error("白名单外的信号应被拒绝")
	}
}
