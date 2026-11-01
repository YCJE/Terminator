package settings

import (
	"os"
	"path/filepath"
	"testing"
)

// newTestService 构造一个只操作临时目录的设置服务，避免碰到真实用户配置。
func newTestService(t *testing.T) *SettingsService {
	t.Helper()
	return NewSettingsService(t.TempDir())
}

func TestRecentHostsOrderAndDedupe(t *testing.T) {
	svc := newTestService(t)

	for _, id := range []string{"a", "b", "c"} {
		if err := svc.RecordHostUsed(id); err != nil {
			t.Fatalf("记录 %q 失败: %v", id, err)
		}
	}

	got := svc.GetRecentHosts()
	if len(got) != 3 {
		t.Fatalf("期望 3 条记录，实际 %d 条", len(got))
	}
	// 最新记录在最前
	if got[0].HostID != "c" || got[1].HostID != "b" || got[2].HostID != "a" {
		t.Fatalf("顺序不正确: %+v", got)
	}

	// 重复记录应把主机移到最前而不是新增一条
	if err := svc.RecordHostUsed("a"); err != nil {
		t.Fatalf("重复记录失败: %v", err)
	}
	got = svc.GetRecentHosts()
	if len(got) != 3 {
		t.Fatalf("重复记录不应新增条目，实际 %d 条", len(got))
	}
	if got[0].HostID != "a" {
		t.Fatalf("重复记录后应排在最前，实际 %+v", got)
	}
}

func TestRecentHostsLimit(t *testing.T) {
	svc := newTestService(t)
	// 写入超过上限的条目，只应保留最近的 recentHostsLimit 条
	for i := 0; i < recentHostsLimit+5; i++ {
		id := "host-" + string(rune('A'+i))
		if err := svc.RecordHostUsed(id); err != nil {
			t.Fatalf("记录 %q 失败: %v", id, err)
		}
	}
	got := svc.GetRecentHosts()
	if len(got) != recentHostsLimit {
		t.Fatalf("期望裁剪到 %d 条，实际 %d 条", recentHostsLimit, len(got))
	}
}

// 记录文件被手工改坏时不能影响主机页渲染，应降级为空列表。
func TestRecentHostsCorruptFile(t *testing.T) {
	svc := newTestService(t)
	if err := os.WriteFile(svc.recentHostsPath(), []byte("not json"), 0600); err != nil {
		t.Fatalf("写入损坏文件失败: %v", err)
	}
	if got := svc.GetRecentHosts(); len(got) != 0 {
		t.Fatalf("损坏文件应返回空列表，实际 %+v", got)
	}
	// 损坏后仍能正常写入新记录
	if err := svc.RecordHostUsed("x"); err != nil {
		t.Fatalf("损坏文件后写入失败: %v", err)
	}
	if got := svc.GetRecentHosts(); len(got) != 1 || got[0].HostID != "x" {
		t.Fatalf("损坏后应能写入新记录，实际 %+v", got)
	}
}

func TestRecentHostsSkipsEmptyID(t *testing.T) {
	svc := newTestService(t)
	if err := svc.RecordHostUsed("   "); err != nil {
		t.Fatalf("空白 ID 不应报错: %v", err)
	}
	if got := svc.GetRecentHosts(); len(got) != 0 {
		t.Fatalf("空白 ID 不应被记录，实际 %+v", got)
	}
}

func TestClearRecentHosts(t *testing.T) {
	svc := newTestService(t)
	if err := svc.RecordHostUsed("a"); err != nil {
		t.Fatalf("记录失败: %v", err)
	}
	if err := svc.ClearRecentHosts(); err != nil {
		t.Fatalf("清空失败: %v", err)
	}
	if got := svc.GetRecentHosts(); len(got) != 0 {
		t.Fatalf("清空后应无记录，实际 %+v", got)
	}
}

func TestWindowStateRoundTrip(t *testing.T) {
	svc := newTestService(t)
	want := WindowState{Width: 1200, Height: 800, X: 100, Y: 60, HasPos: true}
	if err := svc.SaveWindowState(want); err != nil {
		t.Fatalf("写入窗口状态失败: %v", err)
	}
	got := svc.LoadWindowState()
	if got != want {
		t.Fatalf("窗口状态不一致: want %+v, got %+v", want, got)
	}
}

// 越界的尺寸/坐标必须被丢弃，否则可能恢复出不可见或超小的窗口。
func TestWindowStateRejectsOutOfRange(t *testing.T) {
	svc := newTestService(t)
	bad := WindowState{Width: 100, Height: 100, X: 99999, Y: -99999, HasPos: true}
	if err := svc.SaveWindowState(bad); err != nil {
		t.Fatalf("写入窗口状态失败: %v", err)
	}
	got := svc.LoadWindowState()
	if got.Width != 0 || got.Height != 0 {
		t.Fatalf("越界尺寸应被丢弃，实际 %+v", got)
	}
	if got.HasPos || got.X != 0 || got.Y != 0 {
		t.Fatalf("越界坐标应被丢弃，实际 %+v", got)
	}
}

func TestWindowStateMissingFile(t *testing.T) {
	svc := newTestService(t)
	if got := svc.LoadWindowState(); got != (WindowState{}) {
		t.Fatalf("缺少文件时应返回零值，实际 %+v", got)
	}
	// 确认路径确实位于配置目录内
	if dir := filepath.Dir(svc.windowStatePath()); dir != filepath.Dir(svc.configPath) {
		t.Fatalf("window-state.json 应与 settings.json 同目录，实际 %q", dir)
	}
}
