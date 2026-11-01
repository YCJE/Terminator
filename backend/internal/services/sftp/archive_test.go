package sftp

import (
	"archive/zip"
	"context"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var fakeArchiveTime = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

type fakeArchiveInfo struct {
	name string
	size int64
	dir  bool
}

func (f fakeArchiveInfo) Name() string { return f.name }
func (f fakeArchiveInfo) Size() int64  { return f.size }
func (f fakeArchiveInfo) Mode() os.FileMode {
	if f.dir {
		return os.ModeDir | 0o755
	}
	return 0o644
}
func (f fakeArchiveInfo) ModTime() time.Time { return fakeArchiveTime }
func (f fakeArchiveInfo) IsDir() bool        { return f.dir }
func (f fakeArchiveInfo) Sys() any           { return nil }

// fakeArchiveFS 是用内存目录树实现的远端只读文件系统。
type fakeArchiveFS struct {
	files map[string]string
	// dirs 的 value 是子路径；子路径既可能是 files 键，也可能是 dirs 键
	dirs map[string][]string
}

func (f *fakeArchiveFS) stat(p string) (os.FileInfo, error) {
	if content, ok := f.files[p]; ok {
		return fakeArchiveInfo{name: path.Base(p), size: int64(len(content))}, nil
	}
	if _, ok := f.dirs[p]; ok {
		return fakeArchiveInfo{name: path.Base(p), dir: true}, nil
	}
	return nil, os.ErrNotExist
}

func (f *fakeArchiveFS) readDir(p string) ([]os.FileInfo, error) {
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

func (f *fakeArchiveFS) open(p string) (io.ReadCloser, error) {
	content, ok := f.files[p]
	if !ok {
		return nil, os.ErrNotExist
	}
	return io.NopCloser(strings.NewReader(content)), nil
}

// 远端服务端可控的文件名不能参与本地/目标路径拼接。
func TestIsSafeEntryName(t *testing.T) {
	safe := []string{"a.txt", "dir-1", "weird name.txt", "..a.txt", "a..b"}
	for _, name := range safe {
		if !isSafeEntryName(name) {
			t.Errorf("%q 应被视为安全文件名", name)
		}
	}
	unsafe := []string{"", ".", "..", "../evil", "a/b", `a\b`, `..\evil`, "a\x00b"}
	for _, name := range unsafe {
		if isSafeEntryName(name) {
			t.Errorf("%q 应被视为不安全文件名", name)
		}
	}
}

// unsafeNameFS 模拟返回带路径分隔符文件名的异常服务端。
type unsafeNameFS struct{}

func (unsafeNameFS) stat(p string) (os.FileInfo, error) {
	if p == "/root" {
		return fakeArchiveInfo{name: "root", dir: true}, nil
	}
	return fakeArchiveInfo{name: path.Base(p), size: 1}, nil
}

func (unsafeNameFS) readDir(string) ([]os.FileInfo, error) {
	return []os.FileInfo{
		fakeArchiveInfo{name: "../evil.txt", size: 4},
		fakeArchiveInfo{name: "ok.txt", size: 1},
	}, nil
}

func (unsafeNameFS) open(string) (io.ReadCloser, error) {
	return io.NopCloser(strings.NewReader("x")), nil
}

// 打包下载必须丢弃带路径分隔符的条目，避免生成 zip-slip 成员。
func TestCollectArchiveEntriesSkipsUnsafeNames(t *testing.T) {
	entries, _, err := collectArchiveEntries(unsafeNameFS{}, []string{"/root"})
	if err != nil {
		t.Fatalf("收集条目失败: %v", err)
	}
	for _, entry := range entries {
		if !isSafeEntryName(path.Base(entry.zipName)) || strings.Contains(entry.zipName, "..") {
			t.Fatalf("ZIP 中出现不安全条目: %q", entry.zipName)
		}
	}
	found := false
	for _, entry := range entries {
		if entry.zipName == "root/ok.txt" {
			found = true
		}
	}
	if !found {
		t.Fatalf("正常条目应保留，实际: %+v", entries)
	}
}

type archiveProgress struct {
	transferred int64
	total       int64
}

type fakeSFTPEmitter struct {
	progress   []archiveProgress
	completes  []bool
	completeEr []string
}

func (e *fakeSFTPEmitter) EmitTransferProgress(_ string, _ string, _ string, transferred int64, total int64) {
	e.progress = append(e.progress, archiveProgress{transferred: transferred, total: total})
}

func (e *fakeSFTPEmitter) EmitTransferComplete(_ string, _ string, success bool, err string) {
	e.completes = append(e.completes, success)
	e.completeEr = append(e.completeEr, err)
}

func newTestShareFS() *fakeArchiveFS {
	return &fakeArchiveFS{
		files: map[string]string{
			"/srv/share/a.txt":     "abc",
			"/srv/share/dir/b.txt": "hello",
			"/srv/share/.hidden":   "x",
		},
		dirs: map[string][]string{
			"/srv/share":           {"/srv/share/a.txt", "/srv/share/dir", "/srv/share/.hidden"},
			"/srv/share/dir":       {"/srv/share/dir/b.txt", "/srv/share/dir/empty"},
			"/srv/share/dir/empty": {},
		},
	}
}

func TestDownloadArchiveCreatesZip(t *testing.T) {
	target := filepath.Join(t.TempDir(), "share.zip")
	emitter := &fakeSFTPEmitter{}
	svc := NewSftpService(nil, emitter)

	if err := svc.downloadArchive(
		context.Background(), newTestShareFS(), "s1", "t1", target, []string{"/srv/share"},
	); err != nil {
		t.Fatalf("downloadArchive 失败: %v", err)
	}

	reader, err := zip.OpenReader(target)
	if err != nil {
		t.Fatalf("打开压缩包失败: %v", err)
	}
	defer reader.Close()

	names := map[string]bool{}
	for _, file := range reader.File {
		names[file.Name] = true
	}
	for _, want := range []string{
		"share/a.txt",
		"share/dir/b.txt",
		"share/dir/empty/",
		"share/.hidden",
	} {
		if !names[want] {
			t.Errorf("压缩包缺少条目 %q，实际条目: %v", want, names)
		}
	}
	if len(reader.File) != 6 {
		t.Errorf("条目数 = %d，期望 6（根目录 + 3 个文件 + 2 个目录）", len(reader.File))
	}

	var content string
	for _, file := range reader.File {
		if file.Name != "share/dir/b.txt" {
			continue
		}
		rc, err := file.Open()
		if err != nil {
			t.Fatalf("读取压缩包内文件失败: %v", err)
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("读取内容失败: %v", err)
		}
		content = string(data)
	}
	if content != "hello" {
		t.Fatalf("b.txt 内容 = %q，期望 hello", content)
	}

	if len(emitter.progress) == 0 {
		t.Fatal("没有收到任何进度事件")
	}
	last := emitter.progress[len(emitter.progress)-1]
	if last.total != 9 || last.transferred != 9 {
		t.Fatalf("最终进度 = %d/%d，期望 9/9", last.transferred, last.total)
	}
	if len(emitter.completes) != 0 {
		t.Fatal("核心归档函数不应自行发送完成事件（由服务方法负责）")
	}
}

func TestDownloadArchiveSeparatesDuplicateNames(t *testing.T) {
	src := &fakeArchiveFS{
		files: map[string]string{
			"/a/dup.txt": "first",
			"/b/dup.txt": "second",
		},
		dirs: map[string][]string{
			"/a": {"/a/dup.txt"},
			"/b": {"/b/dup.txt"},
		},
	}
	target := filepath.Join(t.TempDir(), "dup.zip")
	svc := NewSftpService(nil, &fakeSFTPEmitter{})
	if err := svc.downloadArchive(
		context.Background(), src, "s1", "t1", target, []string{"/a/dup.txt", "/b/dup.txt"},
	); err != nil {
		t.Fatalf("downloadArchive 失败: %v", err)
	}

	reader, err := zip.OpenReader(target)
	if err != nil {
		t.Fatalf("打开压缩包失败: %v", err)
	}
	defer reader.Close()
	names := map[string]bool{}
	for _, file := range reader.File {
		names[file.Name] = true
	}
	if !names["dup.txt"] || !names["dup (2).txt"] {
		t.Fatalf("同名条目没有正确去重，实际条目: %v", names)
	}
}

func TestDownloadArchiveCancelRemovesTemp(t *testing.T) {
	target := filepath.Join(t.TempDir(), "canceled.zip")
	svc := NewSftpService(nil, &fakeSFTPEmitter{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := svc.downloadArchive(ctx, newTestShareFS(), "s1", "t1", target, []string{"/srv/share"})
	if !errors.Is(err, errTransferCanceled) {
		t.Fatalf("取消后错误 = %v，期望 errTransferCanceled", err)
	}
	for _, p := range []string{target, target + ".terminator-zip-part"} {
		if _, statErr := os.Stat(p); !os.IsNotExist(statErr) {
			t.Errorf("取消后不应残留 %q", p)
		}
	}
}

func TestDownloadArchiveMissingPathFails(t *testing.T) {
	target := filepath.Join(t.TempDir(), "missing.zip")
	svc := NewSftpService(nil, &fakeSFTPEmitter{})
	err := svc.downloadArchive(
		context.Background(), newTestShareFS(), "s1", "t1", target, []string{"/nope"},
	)
	if err == nil {
		t.Fatal("不存在的远程路径应当报错")
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Fatal("失败时不应生成目标压缩包")
	}
}
