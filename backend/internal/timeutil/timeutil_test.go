package timeutil

import (
	"testing"
	"time"
)

func TestFormatIsFixedWidth(t *testing.T) {
	ts := time.Date(2026, 7, 5, 9, 17, 37, 500000000, time.UTC)
	const want = "2026-07-05T09:17:37.500000000Z"
	if got := Format(ts); got != want {
		t.Fatalf("Format = %q, want %q", got, want)
	}
}

// 定长格式的核心保证：字典序与时间序一致。
func TestFormatOrderingMatchesTimeOrdering(t *testing.T) {
	base := time.Date(2026, 7, 5, 9, 17, 37, 0, time.UTC)
	ordered := []time.Time{
		base,
		base.Add(time.Nanosecond),
		base.Add(500 * time.Millisecond),
		base.Add(1 * time.Second),
		base.Add(24 * time.Hour),
	}
	for i := 1; i < len(ordered); i++ {
		if !(Format(ordered[i-1]) < Format(ordered[i])) {
			t.Fatalf("字符串顺序与时间顺序不一致: %q !< %q",
				Format(ordered[i-1]), Format(ordered[i]))
		}
	}
}

func TestParseAcceptsLegacyAndCanonical(t *testing.T) {
	valid := []string{
		"2026-07-05T09:17:37.500000000Z", // 当前定长格式
		"2026-07-05T09:17:37.5Z",         // 旧版可变宽度
		"2026-07-05T09:17:37Z",           // 旧版无小数部分
	}
	for _, s := range valid {
		if _, err := Parse(s); err != nil {
			t.Errorf("Parse(%q) 失败: %v", s, err)
		}
	}

	if _, err := Parse("not-a-time"); err == nil {
		t.Error("Parse 应拒绝非法时间字符串")
	}
}

// 覆盖本次修复的核心场景：
// 旧格式 last_sync_time ".5Z" 与定长记录 ".500000000Z" 表示同一时刻，
// 但文本比较会因 '0' < 'Z' 把定长记录误判为更小，导致该记录永久漏查。
// SinceBound 回退安全余量后，必须把该记录重新纳入查询范围。
func TestSinceBoundCoversSameSecondHazard(t *testing.T) {
	legacy := "2026-07-05T09:17:37.5Z"
	record := "2026-07-05T09:17:37.500000000Z"

	if record > legacy {
		t.Fatal("前置条件不成立：期望文本比较把定长记录判定为更小")
	}

	if !(record > SinceBound(legacy)) {
		t.Fatalf("SinceBound(%q) = %q，仍未包含记录 %q",
			legacy, SinceBound(legacy), record)
	}
}

func TestSinceBoundFallsBackToEpoch(t *testing.T) {
	if got := SinceBound(""); got != Epoch() {
		t.Errorf("空值应退化为 Epoch，实际 %q", got)
	}
	if got := SinceBound("garbage"); got != Epoch() {
		t.Errorf("非法值应退化为 Epoch，实际 %q", got)
	}
}