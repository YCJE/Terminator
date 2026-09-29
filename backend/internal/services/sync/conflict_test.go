package sync

import "testing"

// 并发编辑判定：只有两端都晚于同步下界各自改动、且密文不同才算冲突。
// 密文相同说明两端内容一致（服务端回显我们刚推送的副本也属于这种情况），
// 不能误报为冲突。
func TestIsConcurrentEdit(t *testing.T) {
	const bound = "2026-09-30T10:00:00.000000000Z"

	cases := []struct {
		name         string
		localCipher  string
		remoteCipher string
		localAt      string
		remoteAt     string
		want         bool
	}{
		{
			name:        "两端各自改动且密文不同",
			localCipher: "aaa", remoteCipher: "bbb",
			localAt: "2026-09-30T10:00:01.000000000Z", remoteAt: "2026-09-30T10:00:02.000000000Z",
			want: true,
		},
		{
			name:        "密文相同不算冲突",
			localCipher: "same", remoteCipher: "same",
			localAt: "2026-09-30T10:00:01.000000000Z", remoteAt: "2026-09-30T10:00:02.000000000Z",
			want: false,
		},
		{
			name:        "仅本地改动",
			localCipher: "aaa", remoteCipher: "bbb",
			localAt: "2026-09-30T10:00:01.000000000Z", remoteAt: "2026-09-30T09:59:59.000000000Z",
			want: false,
		},
		{
			name:        "仅远端改动",
			localCipher: "aaa", remoteCipher: "bbb",
			localAt: "2026-09-30T09:59:59.000000000Z", remoteAt: "2026-09-30T10:00:02.000000000Z",
			want: false,
		},
		{
			name:        "恰好在同步下界上不算改动",
			localCipher: "aaa", remoteCipher: "bbb",
			localAt: bound, remoteAt: "2026-09-30T10:00:02.000000000Z",
			want: false,
		},
		{
			name:        "时间戳无法解析时按已改动处理",
			localCipher: "aaa", remoteCipher: "bbb",
			localAt: "garbage", remoteAt: "2026-09-30T10:00:02.000000000Z",
			want: true,
		},
	}

	for _, c := range cases {
		got := isConcurrentEdit(c.localCipher, c.remoteCipher, c.localAt, c.remoteAt, bound)
		if got != c.want {
			t.Errorf("%s: isConcurrentEdit() = %v, want %v", c.name, got, c.want)
		}
	}
}

// afterBound 的退化策略：任一时间戳不可解析都视为「已改动」，
// 宁可多报一次冲突让用户确认，也不要静默丢弃修改。
func TestAfterBound(t *testing.T) {
	const bound = "2026-09-30T10:00:00.000000000Z"

	cases := []struct {
		name string
		t    string
		want bool
	}{
		{"晚于下界", "2026-09-30T10:00:00.000000001Z", true},
		{"早于下界", "2026-09-30T09:59:59.999999999Z", false},
		{"等于下界", bound, false},
		{"脏数据按已改动处理", "not-a-time", true},
	}

	for _, c := range cases {
		if got := afterBound(c.t, bound); got != c.want {
			t.Errorf("%s: afterBound(%q) = %v, want %v", c.name, c.t, got, c.want)
		}
	}
}
