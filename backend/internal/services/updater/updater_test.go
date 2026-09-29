package updater

import (
	"errors"
	"testing"
)

func TestDownloadUpdateNoPending(t *testing.T) {
	s := NewUpdaterService("", "owner/repo", nil)
	if err := s.DownloadUpdate(); err == nil {
		t.Fatal("无待下载更新时应返回错误")
	}
}

// 并发下载必须被拒绝，避免同一更新包重复下载
func TestDownloadUpdateRejectsConcurrent(t *testing.T) {
	s := NewUpdaterService("", "owner/repo", nil)
	s.mu.Lock()
	s.downloading = true
	s.mu.Unlock()

	err := s.DownloadUpdate()
	if !errors.Is(err, ErrDownloadInProgress) {
		t.Fatalf("并发下载应返回 ErrDownloadInProgress，实际 %v", err)
	}
}

func TestNormalizeVersion(t *testing.T) {
	cases := map[string]string{
		"v0.6.0":  "0.6.0",
		"V0.6.0":  "0.6.0",
		"0.6.0":   "0.6.0",
		"vv1.2.3": "1.2.3",
		"":        "",
	}
	for in, want := range cases {
		if got := normalizeVersion(in); got != want {
			t.Errorf("normalizeVersion(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"0.6.0", "0.5.0", 1},
		{"0.5.0", "0.6.0", -1},
		{"0.6.0", "0.6.0", 0},
		{"0.6.1", "0.6.0", 1},
		{"1.0.0", "0.9.9", 1},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, want %d", c.a, c.b, got, c.want)
		}
	}
}
