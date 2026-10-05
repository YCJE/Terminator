package sftp

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPartPathAppendsSuffix(t *testing.T) {
	got := partPath("/home/u/big.iso", 4096)
	want := "/home/u/big.iso" + partSuffix + "-4096"
	if got != want {
		t.Errorf("partPath = %q, 期望 %q", got, want)
	}
}

// 断点文件名必须随传输总量变化：同一目标路径先后传输不同大小的文件时，
// 旧断点不得被当作新传输的续传起点，否则会拼出内容损坏的文件。
func TestPartPathDistinguishesTotals(t *testing.T) {
	small := partPath("/r/x", 1024)
	large := partPath("/r/x", 2048)
	if small == large {
		t.Errorf("不同大小的传输共用断点文件名: %q", small)
	}
}

// 续传起点只在「临时文件大小严格小于源文件总大小」时才有效。
// 大小相等或更大说明源文件已变化，此时续传会拼出错误内容，必须从头重传。
func TestLocalResumeOffset(t *testing.T) {
	cases := []struct {
		name    string
		prepare func(t *testing.T, part string)
		total   int64
		want    int64
	}{
		{
			name:    "临时文件不存在",
			prepare: func(t *testing.T, part string) {},
			total:   100,
			want:    0,
		},
		{
			name: "已传部分字节",
			prepare: func(t *testing.T, part string) {
				if err := os.WriteFile(part, make([]byte, 40), 0o644); err != nil {
					t.Fatalf("准备临时文件失败: %v", err)
				}
			},
			total: 100,
			want:  40,
		},
		{
			name: "临时文件为空",
			prepare: func(t *testing.T, part string) {
				if err := os.WriteFile(part, nil, 0o644); err != nil {
					t.Fatalf("准备临时文件失败: %v", err)
				}
			},
			total: 100,
			want:  0,
		},
		{
			name: "大小等于源文件",
			prepare: func(t *testing.T, part string) {
				if err := os.WriteFile(part, make([]byte, 100), 0o644); err != nil {
					t.Fatalf("准备临时文件失败: %v", err)
				}
			},
			total: 100,
			want:  0,
		},
		{
			name: "大小超过源文件",
			prepare: func(t *testing.T, part string) {
				if err := os.WriteFile(part, make([]byte, 120), 0o644); err != nil {
					t.Fatalf("准备临时文件失败: %v", err)
				}
			},
			total: 100,
			want:  0,
		},
		{
			name: "路径是目录",
			prepare: func(t *testing.T, part string) {
				if err := os.Mkdir(part, 0o755); err != nil {
					t.Fatalf("准备目录失败: %v", err)
				}
			},
			total: 100,
			want:  0,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			part := filepath.Join(t.TempDir(), "file"+partSuffix)
			c.prepare(t, part)

			if got := localResumeOffset(part, c.total); got != c.want {
				t.Errorf("localResumeOffset = %d, 期望 %d", got, c.want)
			}
		})
	}
}
