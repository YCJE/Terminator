package editor

import (
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

type fakeInfo struct {
	name string
	size int64
	mode os.FileMode
	mod  time.Time
}

func (f fakeInfo) Name() string      { return f.name }
func (f fakeInfo) Size() int64       { return f.size }
func (f fakeInfo) Mode() os.FileMode { return f.mode }
func (f fakeInfo) ModTime() time.Time {
	return f.mod
}
func (f fakeInfo) IsDir() bool { return f.mode.IsDir() }
func (f fakeInfo) Sys() any    { return nil }

// fakeRemote 用内存内容模拟远端 SFTP。
type fakeRemote struct {
	files map[string]string
	mods  map[string]time.Time
}

func (f *fakeRemote) Stat(p string) (os.FileInfo, error) {
	content, ok := f.files[p]
	if !ok {
		return nil, os.ErrNotExist
	}
	mod, ok := f.mods[p]
	if !ok {
		mod = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	}
	return fakeInfo{
		name: p,
		size: int64(len(content)),
		mode: 0o644,
		mod:  mod,
	}, nil
}

func (f *fakeRemote) Open(p string) (io.ReadCloser, error) {
	content, ok := f.files[p]
	if !ok {
		return nil, os.ErrNotExist
	}
	return io.NopCloser(strings.NewReader(content)), nil
}

type fakeProvider struct {
	remote *fakeRemote
	err    error
}

func (p fakeProvider) GetSFTPClient(string) (RemoteFS, error) {
	if p.err != nil {
		return nil, p.err
	}
	return p.remote, nil
}

type fakeWriter struct {
	calls   int
	session string
	local   string
	remote  string
	err     error
}

func (w *fakeWriter) WriteLocalFileToRemote(sessionID string, localPath string, remotePath string) error {
	w.calls++
	w.session = sessionID
	w.local = localPath
	w.remote = remotePath
	return w.err
}

type savedEvent struct {
	sessionID  string
	remotePath string
	success    bool
	conflict   bool
	errMsg     string
}

type fakeEditorEmitter struct {
	events []savedEvent
}

func (e *fakeEditorEmitter) EmitEditorSaved(sessionID string, remotePath string, success bool, conflict bool, errMsg string) {
	e.events = append(e.events, savedEvent{
		sessionID:  sessionID,
		remotePath: remotePath,
		success:    success,
		conflict:   conflict,
		errMsg:     errMsg,
	})
}

func TestLocalEditorFileName(t *testing.T) {
	cases := map[string]string{
		"/etc/nginx/nginx.conf": "nginx.conf",
		"/home/a:b*c?.txt":      "a_b_c_.txt",
		"/tmp/weird/na\nme.txt": "name.txt",
		"/":                     "remote-file",
		"/tmp/":                 "tmp",
		// ".." 会拼出临时目录的父路径，必须回退成普通文件名
		"..": "remote-file",
		"/tmp/..": "remote-file",
	}
	for input, want := range cases {
		if got := localEditorFileName(input); got != want {
			t.Errorf("localEditorFileName(%q) = %q，期望 %q", input, got, want)
		}
	}
}

func TestDownloadToWritesContent(t *testing.T) {
	remote := &fakeRemote{files: map[string]string{"/remote/a.txt": "hello remote"}}
	target := t.TempDir() + "/a.txt"
	if err := downloadTo(remote, "/remote/a.txt", target); err != nil {
		t.Fatalf("downloadTo 失败: %v", err)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("读取本地临时文件失败: %v", err)
	}
	if string(data) != "hello remote" {
		t.Fatalf("内容 = %q，期望 hello remote", string(data))
	}
}

func newUploadTestWatcher(t *testing.T, remote *fakeRemote) (*Service, *watcher, *fakeWriter, *fakeEditorEmitter) {
	t.Helper()
	dir := t.TempDir()
	localPath := dir + "/a.txt"
	if err := os.WriteFile(localPath, []byte("edited"), 0o600); err != nil {
		t.Fatalf("准备本地文件失败: %v", err)
	}
	writer := &fakeWriter{}
	emitter := &fakeEditorEmitter{}
	svc := newService(fakeProvider{remote: remote}, writer, emitter)
	info, err := remote.Stat("/remote/a.txt")
	if err != nil {
		t.Fatalf("stat 失败: %v", err)
	}
	w := &watcher{
		key:        "s1\n/remote/a.txt",
		sessionID:  "s1",
		remotePath: "/remote/a.txt",
		localDir:   dir,
		localPath:  localPath,
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
		remoteMod:  info.ModTime(),
		remoteSize: info.Size(),
	}
	return svc, w, writer, emitter
}

func TestUploadBackWritesWhenRemoteUnchanged(t *testing.T) {
	remote := &fakeRemote{files: map[string]string{"/remote/a.txt": "original"}}
	svc, w, writer, emitter := newUploadTestWatcher(t, remote)

	svc.uploadBack(w)

	if writer.calls != 1 {
		t.Fatalf("写回次数 = %d，期望 1", writer.calls)
	}
	if writer.local != w.localPath || writer.remote != w.remotePath || writer.session != "s1" {
		t.Errorf("写回参数不正确: %+v", writer)
	}
	if len(emitter.events) != 1 || !emitter.events[0].success || emitter.events[0].conflict {
		t.Fatalf("期望一次成功事件，实际: %+v", emitter.events)
	}
}

func TestUploadBackSkipsOnRemoteConflict(t *testing.T) {
	remote := &fakeRemote{
		files: map[string]string{"/remote/a.txt": "changed by others"},
		mods:  map[string]time.Time{"/remote/a.txt": time.Date(2026, 5, 6, 7, 8, 9, 0, time.UTC)},
	}
	svc, w, writer, emitter := newUploadTestWatcher(t, remote)
	// 基线仍为下载时的状态（大小 8、旧 mtime），远端此刻已是 18 字节且 mtime 已变
	w.remoteSize = int64(len("original"))
	w.remoteMod = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

	svc.uploadBack(w)
	if writer.calls != 0 {
		t.Fatalf("远端冲突时不应写回，实际写回 %d 次", writer.calls)
	}
	if len(emitter.events) != 1 || emitter.events[0].success || !emitter.events[0].conflict {
		t.Fatalf("期望一次冲突事件，实际: %+v", emitter.events)
	}

	// 冲突只提示一次，避免每次编辑都刷告警
	svc.uploadBack(w)
	if len(emitter.events) != 1 {
		t.Fatalf("冲突应只提示一次，实际事件: %+v", emitter.events)
	}
}

// 远端文件名不可信：会被系统当作可执行文件打开的后缀必须改成文本后缀，
// 否则打开远端 .bat/.cmd/.exe 会在本机直接执行远端内容。
func TestSafeEditorFileNameNeutralizesExecutables(t *testing.T) {
	cases := map[string]string{
		"run.bat":        "run.bat.txt",
		"setup.EXE":      "setup.EXE.txt",
		"script.ps1":     "script.ps1.txt",
		"notes.txt":      "notes.txt",
		"deploy.sh":      "deploy.sh",
		"Makefile":       "Makefile",
		"archive.tar.gz": "archive.tar.gz",
	}
	for in, want := range cases {
		if got := safeEditorFileName(in); got != want {
			t.Errorf("safeEditorFileName(%q) = %q, want %q", in, got, want)
		}
	}
}

// 远端文件在编辑期间被删除时必须跳过自动保存，不能把它重新创建出来。
func TestUploadBackSkipsWhenRemoteDeleted(t *testing.T) {
	remote := &fakeRemote{files: map[string]string{"/remote/a.txt": "original"}}
	svc, w, writer, emitter := newUploadTestWatcher(t, remote)
	delete(remote.files, w.remotePath)

	if outcome := svc.uploadBack(w); outcome != uploadConflict {
		t.Fatalf("远端已删除时应返回冲突，实际 %v", outcome)
	}
	if writer.calls != 0 {
		t.Fatalf("远端已删除时不应写回，实际 %d 次", writer.calls)
	}
	if len(emitter.events) != 1 || emitter.events[0].success || !emitter.events[0].conflict {
		t.Fatalf("期望一次冲突事件，实际: %+v", emitter.events)
	}

	// 冲突只提示一次
	svc.uploadBack(w)
	if len(emitter.events) != 1 {
		t.Fatalf("冲突应只提示一次，实际事件: %+v", emitter.events)
	}
}

func TestUploadBackReportsWriteError(t *testing.T) {
	remote := &fakeRemote{files: map[string]string{"/remote/a.txt": "original"}}
	svc, w, writer, emitter := newUploadTestWatcher(t, remote)
	writer.err = errors.New("网络中断")

	svc.uploadBack(w)
	if writer.calls != 1 {
		t.Fatalf("写回次数 = %d，期望 1", writer.calls)
	}
	if len(emitter.events) != 1 || emitter.events[0].success || emitter.events[0].conflict {
		t.Fatalf("期望一次失败事件，实际: %+v", emitter.events)
	}
	if !strings.Contains(emitter.events[0].errMsg, "网络中断") {
		t.Errorf("失败原因应包含原始错误，实际 %q", emitter.events[0].errMsg)
	}
}
