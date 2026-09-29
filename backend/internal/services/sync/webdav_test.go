package sync

import "testing"

// WebDAV 同步文件 URL 的路径拼接，需正确处理带/不带尾斜杠、
// 仅主机名以及非法输入等边界情况。
func TestBuildSyncFileURL(t *testing.T) {
	cases := []struct {
		name    string
		base    string
		want    string
		wantErr bool
	}{
		{
			name: "无尾斜杠",
			base: "https://dav.example.com/remote.php/dav/files/user",
			want: "https://dav.example.com/remote.php/dav/files/user/syncdata.enc",
		},
		{
			name: "带尾斜杠",
			base: "https://dav.example.com/remote.php/dav/files/user/",
			want: "https://dav.example.com/remote.php/dav/files/user/syncdata.enc",
		},
		{
			name: "仅主机名",
			base: "https://dav.example.com",
			want: "https://dav.example.com/syncdata.enc",
		},
		{
			name: "根路径",
			base: "https://dav.example.com/",
			want: "https://dav.example.com/syncdata.enc",
		},
		{
			name:    "缺少协议",
			base:    "://bad url",
			wantErr: true,
		},
	}

	for _, c := range cases {
		got, err := buildSyncFileURL(c.base)
		if c.wantErr {
			if err == nil {
				t.Errorf("%s: 期望返回错误，实际得到 %q", c.name, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: 意外错误 %v", c.name, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s: buildSyncFileURL(%q) = %q, want %q", c.name, c.base, got, c.want)
		}
	}
}

// 冲突合并规则：仅当远端严格更新时覆盖本地；时间戳相同时保留本地，
// 避免多端在同一时刻写入导致反复互相覆盖。
func TestRemoteWins(t *testing.T) {
	cases := []struct {
		name          string
		local, remote string
		want          bool
	}{
		{"远端更新", "2026-07-05T09:17:37Z", "2026-07-05T09:17:38Z", true},
		{"本地更新", "2026-07-05T09:17:38Z", "2026-07-05T09:17:37Z", false},
		{"同一时刻不同格式保留本地", "2026-07-05T09:17:37Z", "2026-07-05T09:17:37.000000000Z", false},
		{"本地脏数据时远端胜出", "garbage", "2026-07-05T09:17:37Z", true},
		{"远端脏数据时保留本地", "2026-07-05T09:17:37Z", "garbage", false},
		{"双方均脏数据保留本地", "garbage", "garbage", false},
	}

	for _, c := range cases {
		got := remoteWins(
			webdavBlob{UpdatedAt: c.local},
			webdavBlob{UpdatedAt: c.remote},
		)
		if got != c.want {
			t.Errorf("%s: remoteWins(local=%q, remote=%q) = %v, want %v", c.name, c.local, c.remote, got, c.want)
		}
	}
}
