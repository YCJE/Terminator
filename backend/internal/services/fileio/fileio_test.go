package fileio

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSaveAndReadText(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "out.txt")
	svc := NewTextFileService()

	if err := svc.SaveText(path, "第一行\n第二行\n"); err != nil {
		t.Fatalf("SaveText 失败: %v", err)
	}
	got, err := svc.ReadText(path)
	if err != nil {
		t.Fatalf("ReadText 失败: %v", err)
	}
	if got != "第一行\n第二行\n" {
		t.Fatalf("内容不一致: %q", got)
	}
}

func TestSaveTextRejectsEmptyPath(t *testing.T) {
	svc := NewTextFileService()
	if err := svc.SaveText("   ", "x"); err == nil {
		t.Fatal("空路径应当报错")
	}
}

func TestSaveTextRejectsDirectory(t *testing.T) {
	dir := t.TempDir()
	svc := NewTextFileService()
	if err := svc.SaveText(dir, "x"); err == nil {
		t.Fatal("目标是目录时应当报错")
	}
}

func TestSaveTextRejectsOversizedContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "big.txt")
	svc := NewTextFileService()
	content := strings.Repeat("a", maxTextBytes+1)
	if err := svc.SaveText(path, content); err == nil {
		t.Fatal("超过上限的内容应当被拒绝")
	}
}

func TestReadTextRejectsMissingFile(t *testing.T) {
	svc := NewTextFileService()
	if _, err := svc.ReadText(filepath.Join(t.TempDir(), "missing.txt")); err == nil {
		t.Fatal("读取不存在的文件应当报错")
	}
}

func TestListLocalDirSortsAndReportsFields(t *testing.T) {
	dir := t.TempDir()
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatalf("创建子目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hi"), 0o600); err != nil {
		t.Fatalf("写入文件失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "C.txt"), []byte("x"), 0o600); err != nil {
		t.Fatalf("写入文件失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".env"), nil, 0o600); err != nil {
		t.Fatalf("写入隐藏文件失败: %v", err)
	}

	svc := NewTextFileService()
	listing, err := svc.ListLocalDir(dir)
	if err != nil {
		t.Fatalf("ListLocalDir 失败: %v", err)
	}
	if listing.Path == "" || listing.Parent == "" {
		t.Fatalf("路径信息缺失: path=%q parent=%q", listing.Path, listing.Parent)
	}
	if listing.Truncated {
		t.Fatal("小目录不应被截断")
	}
	// 目录优先，其余按名称不区分大小写
	want := []string{"sub", ".env", "a.txt", "C.txt"}
	if len(listing.Entries) != len(want) {
		t.Fatalf("条目数量 = %d，期望 %d", len(listing.Entries), len(want))
	}
	for i, name := range want {
		entry := listing.Entries[i]
		if entry.Name != name {
			t.Fatalf("第 %d 个条目 = %q，期望 %q", i, entry.Name, name)
		}
		if entry.Path == "" || !strings.HasPrefix(entry.Path, listing.Path) {
			t.Fatalf("条目路径不完整: %q", entry.Path)
		}
	}
	if !listing.Entries[0].IsDir {
		t.Fatal("子目录应当标记为目录")
	}
	if listing.Entries[2].Size != 2 {
		t.Fatalf("a.txt 大小 = %d，期望 2", listing.Entries[2].Size)
	}
}

func TestListLocalDirRejectsFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file.txt")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatalf("写入文件失败: %v", err)
	}
	svc := NewTextFileService()
	if _, err := svc.ListLocalDir(path); err == nil {
		t.Fatal("目标不是目录时应当报错")
	}
}

func TestListLocalDirDefaultsToHome(t *testing.T) {
	svc := NewTextFileService()
	home, err := svc.LocalHomeDir()
	if err != nil || home == "" {
		t.Fatalf("LocalHomeDir 失败: %v", err)
	}
	listing, err := svc.ListLocalDir("")
	if err != nil {
		t.Fatalf("空路径应回退到主目录: %v", err)
	}
	if listing.Home != home {
		t.Fatalf("Home = %q，期望 %q", listing.Home, home)
	}
	if !strings.HasPrefix(listing.Path, filepath.Clean(home)) {
		t.Fatalf("Path = %q，期望位于主目录 %q", listing.Path, home)
	}
}

func TestMkdirLocalCreatesDirectory(t *testing.T) {
	svc := NewTextFileService()
	target := filepath.Join(t.TempDir(), "新建目录")
	if err := svc.MkdirLocal(target); err != nil {
		t.Fatalf("MkdirLocal 失败: %v", err)
	}
	info, err := os.Stat(target)
	if err != nil || !info.IsDir() {
		t.Fatalf("目录未创建: %v", err)
	}
	// 重复创建同一目录必须报错，否则前端无法区分"新建成功"与"目录已存在"
	if err := svc.MkdirLocal(target); err == nil {
		t.Fatal("目录已存在时应当报错")
	}
}

func TestMkdirLocalRejectsRelativePath(t *testing.T) {
	svc := NewTextFileService()
	if err := svc.MkdirLocal("relative-dir"); err == nil {
		t.Fatal("相对路径应当被拒绝")
	}
}

func TestRenameLocalMovesFile(t *testing.T) {
	dir := t.TempDir()
	from := filepath.Join(dir, "old.txt")
	to := filepath.Join(dir, "new.txt")
	if err := os.WriteFile(from, []byte("data"), 0o600); err != nil {
		t.Fatalf("准备文件失败: %v", err)
	}
	svc := NewTextFileService()
	if err := svc.RenameLocal(from, to); err != nil {
		t.Fatalf("RenameLocal 失败: %v", err)
	}
	if _, err := os.Stat(from); !os.IsNotExist(err) {
		t.Fatal("旧路径仍然存在")
	}
	data, err := os.ReadFile(to)
	if err != nil || string(data) != "data" {
		t.Fatalf("新路径内容异常: %q, %v", data, err)
	}
}

func TestRenameLocalRejectsExistingTarget(t *testing.T) {
	dir := t.TempDir()
	from := filepath.Join(dir, "a.txt")
	to := filepath.Join(dir, "b.txt")
	if err := os.WriteFile(from, []byte("a"), 0o600); err != nil {
		t.Fatalf("准备源文件失败: %v", err)
	}
	if err := os.WriteFile(to, []byte("b"), 0o600); err != nil {
		t.Fatalf("准备目标文件失败: %v", err)
	}
	svc := NewTextFileService()
	if err := svc.RenameLocal(from, to); err == nil {
		t.Fatal("目标已存在时应当报错，避免静默覆盖")
	}
	// 拒绝后源文件必须保持原样
	if _, err := os.Stat(from); err != nil {
		t.Fatalf("源文件被误删除: %v", err)
	}
}

func TestRenameLocalRejectsRelativePath(t *testing.T) {
	svc := NewTextFileService()
	dir := t.TempDir()
	file := filepath.Join(dir, "x.txt")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatalf("准备文件失败: %v", err)
	}
	if err := svc.RenameLocal(file, "relative.txt"); err == nil {
		t.Fatal("相对目标路径应当被拒绝")
	}
}

func TestRemoveLocalDeletesFile(t *testing.T) {
	target := filepath.Join(t.TempDir(), "gone.txt")
	if err := os.WriteFile(target, []byte("x"), 0o600); err != nil {
		t.Fatalf("准备文件失败: %v", err)
	}
	svc := NewTextFileService()
	if err := svc.RemoveLocal(target, false); err != nil {
		t.Fatalf("RemoveLocal 失败: %v", err)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Fatal("文件未被删除")
	}
}

func TestRemoveLocalDirectoryNeedsRecursive(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatalf("创建子目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sub, "keep.txt"), []byte("x"), 0o600); err != nil {
		t.Fatalf("准备文件失败: %v", err)
	}

	svc := NewTextFileService()
	// 非递归删除非空目录必须失败，并保留目录内容
	if err := svc.RemoveLocal(sub, false); err == nil {
		t.Fatal("非空目录在非递归模式下应当报错")
	}
	if _, err := os.Stat(filepath.Join(sub, "keep.txt")); err != nil {
		t.Fatalf("非递归删除不应破坏目录内容: %v", err)
	}
	// 递归删除后目录整体消失
	if err := svc.RemoveLocal(sub, true); err != nil {
		t.Fatalf("递归删除失败: %v", err)
	}
	if _, err := os.Stat(sub); !os.IsNotExist(err) {
		t.Fatal("目录未被递归删除")
	}
	// 空目录在非递归模式下可直接删除
	empty := filepath.Join(dir, "empty")
	if err := os.Mkdir(empty, 0o755); err != nil {
		t.Fatalf("创建空目录失败: %v", err)
	}
	if err := svc.RemoveLocal(empty, false); err != nil {
		t.Fatalf("删除空目录失败: %v", err)
	}
}

func TestRemoveLocalRefusesRootAndHome(t *testing.T) {
	svc := NewTextFileService()
	root := filepath.VolumeName(t.TempDir()) + string(filepath.Separator)
	if err := svc.RemoveLocal(root, true); err == nil {
		t.Fatal("根目录应当被拒绝删除")
	}
	home, err := svc.LocalHomeDir()
	if err != nil || home == "" {
		t.Fatalf("LocalHomeDir 失败: %v", err)
	}
	if err := svc.RemoveLocal(home, true); err == nil {
		t.Fatal("用户主目录应当被拒绝删除")
	}
}
