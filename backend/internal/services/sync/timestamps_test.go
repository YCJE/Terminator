package sync

import "testing"

// WebDAV 合并时按时间值而非字符串比较，兼容旧版可变宽度格式与当前定长格式。
func TestSameTimestamp(t *testing.T) {
	cases := []struct {
		name string
		a, b string
		want bool
	}{
		{"同一时刻不同格式", "2026-07-05T09:17:37.500000000Z", "2026-07-05T09:17:37.5Z", true},
		{"无小数与定长", "2026-07-05T09:17:37.000000000Z", "2026-07-05T09:17:37Z", true},
		{"不同时刻", "2026-07-05T09:17:37.000000000Z", "2026-07-05T09:17:38.000000000Z", false},
		{"均无法解析退化为字符串比较", "garbage", "garbage", true},
		{"一方无法解析", "garbage", "2026-07-05T09:17:37Z", false},
	}
	for _, c := range cases {
		if got := sameTimestamp(c.a, c.b); got != c.want {
			t.Errorf("%s: sameTimestamp(%q, %q) = %v, want %v", c.name, c.a, c.b, got, c.want)
		}
	}
}

// 单条时间戳异常不应中断整轮同步，解析失败退化为零值。
func TestParseTimeOrZero(t *testing.T) {
	if got := parseTimeOrZero("2026-07-05T09:17:37Z"); got.IsZero() {
		t.Error("合法时间不应为零值")
	}
	if got := parseTimeOrZero("garbage"); !got.IsZero() {
		t.Errorf("非法时间应为零值，实际 %v", got)
	}
}
