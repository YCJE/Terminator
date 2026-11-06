package sftp

import (
	"context"
	"errors"
	"io"
	"os"
	"path"
	"strings"
	"testing"
	"time"
)

// ---- 内存远端文件系统（源端） ----

type copyInfo struct {
	name string
	size int64
	mode os.FileMode
}

func (c copyInfo) Name() string      { return c.name }
func (c copyInfo) Size() int64       { return c.size }
func (c copyInfo) Mode() os.FileMode { return c.mode }
func (c copyInfo) ModTime() time.Time {
	return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
}
func (c copyInfo) IsDir() bool { return c.mode.IsDir() }
func (c copyInfo) Sys() any    { return nil }

// byteReader 是可 Seek 的内存只读流，模拟 *sftp.File 的读取语义。
type byteReader struct {
	data []byte
	pos  int
}

func (r *byteReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	n := copy(p, r.data[r.pos:])
	r.pos += n
	return n, nil
}

func (r *byteReader) Seek(offset int64, whence int) (int64, error) {
	var pos int
	switch whence {
	case io.SeekStart:
		pos = int(offset)
	case io.SeekCurrent:
		pos = r.pos + int(offset)
	case io.SeekEnd:
		pos = len(r.data) + int(offset)
	default:
		return 0, errors.New("非法 seek 起点")
	}
	if pos < 0 || pos > len(r.data) {
		return 0, errors.New("seek 越界")
	}
	r.pos = pos
	return int64(pos), nil
}

func (r *byteReader) Close() error { return nil }

// fakeCopyFS 是用内存目录树实现的远端源文件系统。
// links/设备文件用于验证复制时被跳过。
type fakeCopyFS struct {
	files   map[string]string
	dirs    map[string][]string
	links   map[string]string
	devices map[string]bool
}

func (f *fakeCopyFS) stat(p string) (os.FileInfo, error) {
	if content, ok := f.files[p]; ok {
		return copyInfo{name: path.Base(p), size: int64(len(content)), mode: 0o644}, nil
	}
	if _, ok := f.links[p]; ok {
		return copyInfo{name: path.Base(p), mode: os.ModeSymlink | 0o777}, nil
	}
	if f.devices[p] {
		return copyInfo{name: path.Base(p), mode: os.ModeDevice | 0o644}, nil
	}
	if _, ok := f.dirs[p]; ok {
		return copyInfo{name: path.Base(p), mode: os.ModeDir | 0o755}, nil
	}
	return nil, os.ErrNotExist
}

func (f *fakeCopyFS) readDir(p string) ([]os.FileInfo, error) {
	children, ok := f.dirs[p]
	if !ok {
		return nil, os.ErrNotExist
	}
	infos := make([]os.FileInfo, 0, len(children))
	for _, child := range children {
		info, err := f.stat(child)
		if err != nil {
			return nil, err
		}
		infos = append(infos, info)
	}
	return infos, nil
}

func (f *fakeCopyFS) open(p string) (io.ReadSeekCloser, error) {
	content, ok := f.files[p]
	if !ok {
		return nil, os.ErrNotExist
	}
	return &byteReader{data: []byte(content)}, nil
}

// ---- 内存目标端 ----

type partWriter struct {
	target *fakeCopyTarget
	path   string
	closed bool
}

func (w *partWriter) Write(b []byte) (int, error) {
	if w.closed {
		return 0, errors.New("已关闭的文件不可写")
	}
	w.target.parts[w.path] += string(b)
	return len(b), nil
}

func (w *partWriter) Close() error {
	w.closed = true
	return nil
}

type fakeCopyTarget struct {
	dirs    map[string]bool
	files   map[string]string
	parts   map[string]string
	modes   map[string]os.FileMode
	removed []string
	renamed []string
}

func newFakeCopyTarget() *fakeCopyTarget {
	return &fakeCopyTarget{
		dirs:  map[string]bool{},
		files: map[string]string{},
		parts: map[string]string{},
		modes: map[string]os.FileMode{},
	}
}

func (t *fakeCopyTarget) stat(p string) (os.FileInfo, error) {
	if content, ok := t.files[p]; ok {
		return copyInfo{name: path.Base(p), size: int64(len(content)), mode: 0o644}, nil
	}
	if content, ok := t.parts[p]; ok {
		return copyInfo{name: path.Base(p), size: int64(len(content)), mode: 0o644}, nil
	}
	if t.dirs[p] {
		return copyInfo{name: path.Base(p), mode: os.ModeDir | 0o755}, nil
	}
	return nil, os.ErrNotExist
}

func (t *fakeCopyTarget) mkdirAll(p string) error {
	t.dirs[p] = true
	return nil
}

func (t *fakeCopyTarget) openPart(p string, total int64) (io.WriteCloser, int64, error) {
	offset := int64(0)
	if existing := t.parts[p]; len(existing) > 0 && int64(len(existing)) < total {
		offset = int64(len(existing))
	} else {
		t.parts[p] = ""
	}
	return &partWriter{target: t, path: p}, offset, nil
}

func (t *fakeCopyTarget) renameOver(from string, to string) error {
	content, ok := t.parts[from]
	if !ok {
		return errors.New("临时文件不存在")
	}
	t.files[to] = content
	delete(t.parts, from)
	t.renamed = append(t.renamed, from+" -> "+to)
	return nil
}

func (t *fakeCopyTarget) remove(p string) error {
	t.removed = append(t.removed, p)
	delete(t.parts, p)
	delete(t.files, p)
	return nil
}

func (t *fakeCopyTarget) chmod(p string, mode os.FileMode) error {
	t.modes[p] = mode
	return nil
}

// ---- 用例 ----

func newTestCopySource() *fakeCopyFS {
	return &fakeCopyFS{
		files: map[string]string{
			"/data/a.txt":        "abc",
			"/data/sub/b.txt":    "hello world",
			"/data/sub/empty/.x": "",
			"/data/sub/null-dev": "",
		},
		dirs: map[string][]string{
			"/data":           {"/data/a.txt", "/data/link", "/data/sub"},
			"/data/sub":       {"/data/sub/b.txt", "/data/sub/empty", "/data/sub/dev"},
			"/data/sub/empty": {"/data/sub/empty/.x"},
		},
		links:   map[string]string{"/data/link": "/etc/passwd"},
		devices: map[string]bool{"/data/sub/dev": true},
	}
}

func TestPlanCrossCopyCollectsTree(t *testing.T) {
	plan, err := planCrossCopy(newTestCopySource(), "/data", "/dst/data")
	if err != nil {
		t.Fatalf("planCrossCopy 失败: %v", err)
	}

	wantDirs := []string{"/dst/data", "/dst/data/sub", "/dst/data/sub/empty"}
	if len(plan.dirs) != len(wantDirs) {
		t.Fatalf("目录数量 = %d (%v)，期望 %d (%v)", len(plan.dirs), plan.dirs, len(wantDirs), wantDirs)
	}
	for i, want := range wantDirs {
		if plan.dirs[i] != want {
			t.Errorf("目录[%d] = %q，期望 %q", i, plan.dirs[i], want)
		}
	}

	if len(plan.files) != 3 {
		t.Fatalf("文件数量 = %d，期望 3（符号链接与设备文件应被跳过）", len(plan.files))
	}
	if plan.total != 3+11 {
		t.Errorf("总字节 = %d，期望 14", plan.total)
	}
	for _, file := range plan.files {
		if strings.HasSuffix(file.src, "link") || strings.HasSuffix(file.src, "dev") {
			t.Errorf("不应收集 %q", file.src)
		}
		if file.mode != 0o644 {
			t.Errorf("%q 权限 = %v，期望 0644", file.src, file.mode)
		}
	}
}

func TestRunCrossCopyWritesTree(t *testing.T) {
	src := newTestCopySource()
	dst := newFakeCopyTarget()
	emitter := &fakeSFTPEmitter{}
	svc := NewSftpService(nil, emitter)

	info, err := src.stat("/data")
	if err != nil {
		t.Fatalf("stat 失败: %v", err)
	}
	if err := svc.runCrossCopy(
		context.Background(), src, dst, "s1", "t1", "/data", "/dst/data", info,
	); err != nil {
		t.Fatalf("runCrossCopy 失败: %v", err)
	}

	if got := dst.files["/dst/data/a.txt"]; got != "abc" {
		t.Errorf("a.txt 内容 = %q，期望 abc", got)
	}
	if got := dst.files["/dst/data/sub/b.txt"]; got != "hello world" {
		t.Errorf("b.txt 内容 = %q，期望 hello world", got)
	}
	for _, dir := range []string{"/dst/data", "/dst/data/sub", "/dst/data/sub/empty"} {
		if !dst.dirs[dir] {
			t.Errorf("目标目录 %q 未创建", dir)
		}
	}
	if len(dst.parts) != 0 {
		t.Errorf("完成后不应残留临时文件: %v", dst.parts)
	}
	if dst.modes["/dst/data/a.txt"] != 0o644 {
		t.Errorf("未保留源文件权限: %v", dst.modes)
	}

	last := emitter.progress[len(emitter.progress)-1]
	if last.total != 14 || last.transferred != 14 {
		t.Errorf("最终进度 = %d/%d，期望 14/14", last.transferred, last.total)
	}
	if len(emitter.completes) != 0 {
		t.Fatal("核心复制函数不应自行发送完成事件（由服务方法负责）")
	}
}

func TestRunCrossCopyResumesFromPart(t *testing.T) {
	src := &fakeCopyFS{files: map[string]string{"/a.txt": "abcdef"}}
	dst := newFakeCopyTarget()
	info, err := src.stat("/a.txt")
	if err != nil {
		t.Fatalf("stat 失败: %v", err)
	}
	// 预置前 4 字节的断点文件：名称由「大小 + 源端修改时间 + 传输 ID」共同决定
	dst.parts[partPath("/dst.txt", 6, transferIdentity(info.ModTime(), "t1"))] = "abcd"

	emitter := &fakeSFTPEmitter{}
	svc := NewSftpService(nil, emitter)
	if err := svc.runCrossCopy(
		context.Background(), src, dst, "s1", "t1", "/a.txt", "/dst.txt", info,
	); err != nil {
		t.Fatalf("runCrossCopy 失败: %v", err)
	}

	if got := dst.files["/dst.txt"]; got != "abcdef" {
		t.Errorf("续传结果 = %q，期望 abcdef", got)
	}
	if len(emitter.progress) == 0 || emitter.progress[0].transferred != 4 {
		t.Fatalf("首帧进度应从断点开始，实际: %+v", emitter.progress)
	}
}

// 源文件在复制期间被截短（或 stat 大小与实际内容不一致）时，
// 已复制的内容只是残片，不能重命名成完整副本。
func TestRunCrossCopyDetectsShortRead(t *testing.T) {
	src := &fakeCopyFS{files: map[string]string{"/a.txt": "abc"}}
	dst := newFakeCopyTarget()
	svc := NewSftpService(nil, &fakeSFTPEmitter{})

	info := copyInfo{name: "a.txt", size: 6, mode: 0o644}
	if err := svc.runCrossCopy(
		context.Background(), src, dst, "s1", "t1", "/a.txt", "/dst.txt", info,
	); err == nil {
		t.Fatal("实传字节数少于源文件大小时应返回错误")
	}
	if _, ok := dst.files["/dst.txt"]; ok {
		t.Error("残缺内容不应重命名为目标文件")
	}
	if len(dst.parts) == 0 {
		t.Error("失败时应保留临时文件供续传")
	}
}

func TestRunCrossCopyCanceled(t *testing.T) {
	src := newTestCopySource()
	dst := newFakeCopyTarget()
	svc := NewSftpService(nil, &fakeSFTPEmitter{})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	info, err := src.stat("/data")
	if err != nil {
		t.Fatalf("stat 失败: %v", err)
	}
	if err := svc.runCrossCopy(ctx, src, dst, "s1", "t1", "/data", "/dst/data", info); !errors.Is(err, errTransferCanceled) {
		t.Fatalf("取消后错误 = %v，期望 errTransferCanceled", err)
	}
}

func TestCopyBetweenSessionsRejectsInvalidPaths(t *testing.T) {
	emitter := &fakeSFTPEmitter{}
	svc := NewSftpService(nil, emitter)

	// sshSvc 为 nil：校验必须发生在取客户端之前，否则会空指针崩溃
	if err := svc.CopyBetweenSessions("s1", "", "s2", "/dst", "t1"); err == nil {
		t.Fatal("空源路径应返回错误")
	}
	if err := svc.CopyBetweenSessions("s1", "/a", "s1", "/a", "t2"); err == nil {
		t.Fatal("同会话同路径应返回错误")
	}
	if len(emitter.completes) != 2 || emitter.completes[0] || emitter.completes[1] {
		t.Fatalf("两次校验失败都应推送失败完成事件，实际: %v", emitter.completes)
	}
}
