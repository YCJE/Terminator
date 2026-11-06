package updater

import (
	"errors"
	"io"
	"testing"
	"time"
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

// 服务器返回响应头后不再发送数据时，读取必须被空闲看门狗取消，
// 否则会阻塞到 30 分钟总超时，期间用户既无法重试也无法取消。
func TestIdleCancelReaderCancelsStalledRead(t *testing.T) {
	pr, pw := io.Pipe()
	defer func() { _ = pw.Close() }()

	canceled := make(chan struct{})
	r := newIdleCancelReader(pr, 30*time.Millisecond, func() { close(canceled) })
	defer func() { _ = r.Close() }()

	select {
	case <-canceled:
	case <-time.After(2 * time.Second):
		t.Fatal("空闲超时后未取消请求")
	}
	if !r.timedOut() {
		t.Error("空闲取消后 timedOut() 应为 true")
	}
}

// 持续有数据时看门狗不应触发。
func TestIdleCancelReaderKeepsAliveOnData(t *testing.T) {
	pr, pw := io.Pipe()
	defer func() { _ = pw.Close() }()

	canceled := make(chan struct{})
	r := newIdleCancelReader(pr, 400*time.Millisecond, func() { close(canceled) })
	defer func() { _ = r.Close() }()

	// io.Pipe 的写入会阻塞到有读者消费，因此把写入放到独立 goroutine
	go func() {
		for i := 0; i < 3; i++ {
			time.Sleep(50 * time.Millisecond)
			_, _ = pw.Write([]byte("chunk"))
		}
	}()

	buf := make([]byte, 16)
	for i := 0; i < 3; i++ {
		if _, err := r.Read(buf); err != nil {
			t.Fatalf("读取测试数据失败: %v", err)
		}
	}
	select {
	case <-canceled:
		t.Fatal("持续有数据时不应取消请求")
	default:
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

// 下载地址应优先走 api.github.com 资产端点，github.com 原地址仅作兜底：
// 前者在下载域名被阻断的网络下仍可用。
func TestAssetURLsPrefersAPIAssetEndpoint(t *testing.T) {
	s := NewUpdaterService("", "YCJE/Terminator", nil)

	urls := s.assetURLs(ReleaseAsset{ID: 682413154, DownloadURL: "https://github.com/YCJE/Terminator/releases/download/v0.8.10/SHA256SUMS-windows.txt"})
	if len(urls) != 2 {
		t.Fatalf("应返回 2 个候选地址，实际 %d 个: %v", len(urls), urls)
	}
	wantAPI := "https://api.github.com/repos/YCJE/Terminator/releases/assets/682413154"
	if urls[0] != wantAPI {
		t.Errorf("首选地址应为 %q，实际 %q", wantAPI, urls[0])
	}
	if urls[1] == "" || urls[1] == urls[0] {
		t.Errorf("兜底地址应保留 browser_download_url，实际 %q", urls[1])
	}

	// 没有资产 ID（例如旧版本发布）时只能退回原地址
	urls = s.assetURLs(ReleaseAsset{DownloadURL: "https://github.com/a/b.exe"})
	if len(urls) != 1 || urls[0] != "https://github.com/a/b.exe" {
		t.Errorf("无 ID 时应只返回原地址，实际 %v", urls)
	}
}
