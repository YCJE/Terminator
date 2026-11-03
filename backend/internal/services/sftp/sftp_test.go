package sftp

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 暂停后续传会复用同一个 transferID：旧传输的注销函数不能把新传输的
// 取消句柄一并删除，否则续传后的任务将无法再被取消/暂停。
func TestRegisterTransferKeepsNewerHandle(t *testing.T) {
	svc := NewSftpService(nil, nil)

	_, doneOld := svc.registerTransfer("t1")
	ctxNew, doneNew := svc.registerTransfer("t1")
	defer doneNew()

	// 旧传输结束时才执行清理：此时登记表里已经是新传输
	doneOld()

	svc.mu.Lock()
	entry := svc.cancels["t1"]
	svc.mu.Unlock()
	if entry == nil {
		t.Fatal("旧传输的清理误删了新传输的取消句柄")
	}

	svc.CancelTransfer("t1")
	select {
	case <-ctxNew.Done():
	case <-time.After(time.Second):
		t.Fatal("新传输的取消句柄未生效")
	}
}

func TestPartPathAppendsSuffix(t *testing.T) {
	got := partPath("/home/u/big.iso", 4096, "1700000000000000000|t1")
	if !strings.HasPrefix(got, "/home/u/big.iso"+partSuffix+"-4096-") {
		t.Errorf("partPath = %q, 缺少前缀或总大小", got)
	}
	if strings.Contains(got, "|") || strings.Contains(got, "t1") {
		t.Errorf("partPath = %q, 传输身份未摘要，可能把分隔符带进文件名", got)
	}
}

// 断点文件名必须随「源端身份 + 传输 ID」变化：同一目标路径先后传输不同内容
// 的文件、或同时进行两次传输时，旧断点不得被当作续传起点，否则会拼出损坏文件。
func TestPartPathDistinguishesTotals(t *testing.T) {
	small := partPath("/r/x", 1024, "m1|t1")
	large := partPath("/r/x", 2048, "m1|t1")
	if small == large {
		t.Errorf("不同大小的传输共用断点文件名: %q", small)
	}
}

func TestPartPathDistinguishesIdentity(t *testing.T) {
	changedSource := partPath("/r/x", 1024, "m2|t1")
	otherTransfer := partPath("/r/x", 1024, "m1|t2")
	base := partPath("/r/x", 1024, "m1|t1")
	if base == changedSource || base == otherTransfer {
		t.Errorf("源端变化或不同传输复用了同一个断点文件名: %q", base)
	}
}

// 尾部读取窗口：小于上限时从头读，大于上限时只取末尾；
// 非法/过小的 maxBytes 需被夹取到允许区间，避免一次读回过多内容或空读。
func TestTailWindow(t *testing.T) {
	cases := []struct {
		name     string
		size     int64
		maxBytes int64
		wantOff  int64
		wantLen  int64
	}{
		{name: "空文件", size: 0, maxBytes: 512 << 10, wantOff: 0, wantLen: 0},
		{name: "小于上限", size: 100, maxBytes: 512 << 10, wantOff: 0, wantLen: 100},
		{name: "超过上限", size: 1 << 20, maxBytes: 512 << 10, wantOff: 512 << 10, wantLen: 512 << 10},
		{name: "请求过小被抬高", size: 100, maxBytes: 1, wantOff: 0, wantLen: 100},
		{name: "请求过大被压低", size: 100 << 20, maxBytes: 100 << 20, wantOff: (100 << 20) - (8 << 20), wantLen: 8 << 20},
		{name: "负数大小", size: -1, maxBytes: 512 << 10, wantOff: 0, wantLen: 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			off, length := tailWindow(c.size, c.maxBytes)
			if off != c.wantOff || length != c.wantLen {
				t.Errorf("tailWindow(%d, %d) = (%d, %d)，期望 (%d, %d)",
					c.size, c.maxBytes, off, length, c.wantOff, c.wantLen)
			}
		})
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
