package sftp

import (
	"archive/tar"
	"archive/zip"
	"context"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// 压缩包内应保留原目录结构（含空目录），解压后才能还原原目录。
func TestZipLocalPathPreservesStructure(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "project")
	if err := os.MkdirAll(filepath.Join(source, "sub"), 0o755); err != nil {
		t.Fatalf("创建测试目录失败: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(source, "empty"), 0o755); err != nil {
		t.Fatalf("创建空目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(source, "sub", "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}

	zipPath := filepath.Join(root, "out.zip")
	size, err := zipLocalPath(context.Background(), source, zipPath)
	if err != nil {
		t.Fatalf("压缩失败: %v", err)
	}
	if size <= 0 {
		t.Fatalf("压缩包大小应为正数，实际 %d", size)
	}

	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		t.Fatalf("读取压缩包失败: %v", err)
	}
	defer reader.Close()

	names := make(map[string]bool, len(reader.File))
	for _, entry := range reader.File {
		names[entry.Name] = true
	}
	for _, want := range []string{"project/", "project/sub/", "project/empty/", "project/sub/a.txt"} {
		if !names[want] {
			t.Fatalf("压缩包缺少条目 %q，实际: %v", want, names)
		}
	}

	var content string
	for _, entry := range reader.File {
		if entry.Name != "project/sub/a.txt" {
			continue
		}
		file, err := entry.Open()
		if err != nil {
			t.Fatalf("打开压缩包条目失败: %v", err)
		}
		data, err := io.ReadAll(file)
		_ = file.Close()
		if err != nil {
			t.Fatalf("读取压缩包条目失败: %v", err)
		}
		content = string(data)
	}
	if content != "hello" {
		t.Fatalf("压缩包内容错误: %q", content)
	}
}

// 符号链接不应被打包（避免目录环与目录外内容泄漏）。
func TestZipLocalPathSkipsSymlinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows 上创建符号链接需要额外权限")
	}
	root := t.TempDir()
	source := filepath.Join(root, "linked")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatalf("创建测试目录失败: %v", err)
	}
	outer := filepath.Join(root, "outside.txt")
	if err := os.WriteFile(outer, []byte("secret"), 0o644); err != nil {
		t.Fatalf("写入外部文件失败: %v", err)
	}
	if err := os.Symlink(outer, filepath.Join(source, "link.txt")); err != nil {
		t.Skipf("创建符号链接失败: %v", err)
	}

	zipPath := filepath.Join(root, "linked.zip")
	if _, err := zipLocalPath(context.Background(), source, zipPath); err != nil {
		t.Fatalf("压缩失败: %v", err)
	}
	reader, err := zip.OpenReader(zipPath)
	if err != nil {
		t.Fatalf("读取压缩包失败: %v", err)
	}
	defer reader.Close()
	for _, entry := range reader.File {
		if strings.Contains(entry.Name, "link.txt") {
			t.Fatalf("符号链接不应被打包: %v", entry.Name)
		}
	}
}

func TestExtractCommandFormats(t *testing.T) {
	cases := []struct {
		name     string
		contains string
	}{
		{"pkg.zip", "unzip -o -q"},
		{"pkg.tar", "tar -xf"},
		{"pkg.tar.gz", "tar -xzf"},
		{"pkg.tgz", "tar -xzf"},
		{"pkg.tar.bz2", "tar -xjf"},
		{"pkg.tar.xz", "tar -xJf"},
		{"pkg.7z", `"$tool" x -y`},
		{"pkg.gz", "gzip -d -f"},
	}
	for _, tc := range cases {
		command := extractCommand("/tmp/"+tc.name, "/tmp/target")
		if !strings.Contains(command, tc.contains) {
			t.Fatalf("%s 的解压命令应包含 %q，实际 %q", tc.name, tc.contains, command)
		}
		// 目标目录与压缩包路径都需要被正确引用
		if !strings.Contains(command, "'/tmp/target'") && tc.name != "pkg.gz" {
			t.Fatalf("%s 的命令缺少目标目录引用: %q", tc.name, command)
		}
	}
	if command := extractCommand("/tmp/archive.rar", "/tmp/target"); command != "" {
		t.Fatalf("不支持的格式应返回空命令，实际 %q", command)
	}
}

// .tar.gz / .tgz 不能被当成单文件 gzip 就地解压：
// 那样只会把原包解成 .tar 并删掉，目录既不创建也不展开，却返回成功。
func TestIsSingleFileGzip(t *testing.T) {
	cases := []struct {
		name string
		want bool
	}{
		{"pkg.gz", true},
		{"dir/pkg.gz", true},
		{"PKG.GZ", true},
		{"pkg.tar.gz", false},
		{"pkg.tgz", false},
		{"PKG.TAR.GZ", false},
		{"pkg.zip", false},
	}
	for _, tc := range cases {
		if got := isSingleFileGzip(tc.name); got != tc.want {
			t.Errorf("isSingleFileGzip(%q)=%v, want %v", tc.name, got, tc.want)
		}
	}
}

// 单引号必须被正确转义，否则含引号的路径会截断命令。
func TestShellQuote(t *testing.T) {
	if got := shellQuote("simple"); got != "'simple'" {
		t.Fatalf("普通字符串引用错误: %q", got)
	}
	if got := shellQuote("a'b"); got != `'a'\''b'` {
		t.Fatalf("单引号转义错误: %q", got)
	}
	if got := shellQuote(""); got != "''" {
		t.Fatalf("空字符串引用错误: %q", got)
	}
}

func TestArchiveTopName(t *testing.T) {
	if got := archiveTopName("/home/user/project"); got != "project" {
		t.Fatalf("顶层目录名错误: %q", got)
	}
	if got := archiveTopName(filepath.Join("C:", "data", "dir")); got != "dir" {
		t.Fatalf("Windows 路径顶层目录名错误: %q", got)
	}
	if got := archiveTopName(path.Join("/", "weird")); got != "weird" {
		t.Fatalf("POSIX 路径顶层目录名错误: %q", got)
	}
	// ".." 会被写进压缩包成员名，解压时可能逃出目标目录
	for _, localPath := range []string{"..", filepath.Join("..", ".."), path.Join("a", "..", "..")} {
		if got := archiveTopName(localPath); got != "upload" {
			t.Fatalf("路径 %q 的顶层目录名应回退为 upload，实际 %q", localPath, got)
		}
	}
}

// ZIP 必须先列出成员、校验路径，再解压；校验不可用时中止而不是跳过。
func TestZipExtractScriptValidatesBeforeExtract(t *testing.T) {
	command := extractCommand("/tmp/pkg.zip", "/tmp/target")
	if command == "" {
		t.Fatal("ZIP 解压命令不应为空")
	}
	for _, want := range []string{
		"cd '/tmp/target' || exit 1",
		"python3 -c",
		"zipfile.ZipFile",
		"unzip -Z1",
		"grep -Eq",
		// 无 python3 时必须用 zipinfo 长格式拒绝链接型成员，不能只校验名字
		"command -v zipinfo",
		`grep -Eq "^l"`,
		"unzip -o -q '/tmp/pkg.zip'",
		"python3 -m zipfile -e '/tmp/pkg.zip'",
	} {
		if !strings.Contains(command, want) {
			t.Errorf("ZIP 解压命令缺少 %q:\n%s", want, command)
		}
	}
	listAt := strings.Index(command, "unzip -Z1")
	extractAt := strings.Index(command, "unzip -o -q")
	if listAt < 0 || extractAt < 0 || listAt > extractAt {
		t.Errorf("必须先列出成员校验、再解压:\n%s", command)
	}
	// 校验失败的分支必须中止（exit 非 0），不能继续执行后面的解压命令
	if strings.Count(command, "exit 1") < 3 {
		t.Errorf("校验或创建临时文件失败时必须中止:\n%s", command)
	}
	if !strings.Contains(command, "exit 127") {
		t.Errorf("缺少解压工具时应报错退出:\n%s", command)
	}
}

// 与脚本中 grep -E 使用同一正则，覆盖各类路径穿越写法。
func TestUnsafeZipMemberPattern(t *testing.T) {
	pattern := regexp.MustCompile(`^/|(^|[/\\])\.\.([/\\]|$)`)
	unsafe := []string{
		"../evil.txt",
		"..",
		"dir/..",
		"/etc/passwd",
		"dir/../evil.txt",
		"dir/../../evil.txt",
		`a\..\evil.txt`,
	}
	safe := []string{
		"a.txt",
		"dir/a.txt",
		"..a.txt",
		"a..b.txt",
		"dir/sub/a..b.txt",
		"dir/..a/b.txt",
	}
	for _, name := range unsafe {
		if !pattern.MatchString(name) {
			t.Errorf("成员 %q 应被判为不安全路径", name)
		}
	}
	for _, name := range safe {
		if pattern.MatchString(name) {
			t.Errorf("成员 %q 不应被判为不安全路径", name)
		}
	}
}

// 有 bash 时直接执行生成的脚本：良性压缩包正常解压，含 "../" 成员的压缩包被拒绝。
// 只校验 python3 分支：无 python3 时的 unzip 分支使用上面测试过的同一正则。
func TestZipExtractScriptRejectsTraversal(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("未找到 bash，跳过脚本行为测试")
	}
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("未找到 python3，跳过脚本行为测试")
	}

	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatalf("创建目标目录失败: %v", err)
	}
	run := func(archivePath string) (string, error) {
		command := extractCommand(filepath.ToSlash(archivePath), filepath.ToSlash(target))
		output, err := exec.Command(bash, "-c", command).CombinedOutput()
		return string(output), err
	}

	evilZip := filepath.Join(root, "evil.zip")
	if err := writeZipEntries(evilZip, map[string]string{"../pwned.txt": "pwned"}); err != nil {
		t.Fatalf("创建恶意压缩包失败: %v", err)
	}
	if output, err := run(evilZip); err == nil {
		t.Fatalf("含 ../ 成员的压缩包应被拒绝，实际成功: %s", output)
	}
	if _, err := os.Stat(filepath.Join(root, "pwned.txt")); err == nil {
		t.Fatal("路径穿越成员被写到了目标目录之外")
	}

	goodZip := filepath.Join(root, "good.zip")
	if err := writeZipEntries(goodZip, map[string]string{"dir/a.txt": "hello"}); err != nil {
		t.Fatalf("创建正常压缩包失败: %v", err)
	}
	if output, err := run(goodZip); err != nil {
		t.Fatalf("正常压缩包应能解压: %v, 输出: %s", err, output)
	}
	data, err := os.ReadFile(filepath.Join(target, "dir", "a.txt"))
	if err != nil {
		t.Fatalf("解压后的文件不存在: %v", err)
	}
	if string(data) != "hello" {
		t.Fatalf("解压内容错误: %q", string(data))
	}
}

// TAR 与 7z 的部分实现会接受 "../" 或绝对路径成员，因此与 ZIP 一样，
// 解压前必须先列出成员并用同一正则校验；列表失败时中止而不是直接解压。
func TestTarAnd7zExtractScriptValidateMembers(t *testing.T) {
	cases := []struct{ name, list, extract string }{
		{"pkg.tar", "tar -tf", "tar -xf"},
		{"pkg.tar.gz", "tar -tzf", "tar -xzf"},
		{"pkg.tgz", "tar -tzf", "tar -xzf"},
		{"pkg.tar.bz2", "tar -tjf", "tar -xjf"},
		{"pkg.tar.xz", "tar -tJf", "tar -xJf"},
	}
	for _, tc := range cases {
		command := extractCommand("/tmp/"+tc.name, "/tmp/target")
		if command == "" {
			t.Fatalf("%s 的解压命令不应为空", tc.name)
		}
		for _, want := range []string{
			"cd '/tmp/target' || exit 1",
			tc.list + " '/tmp/" + tc.name + "'",
			"grep -Eq",
			tc.extract + " '/tmp/" + tc.name + "'",
		} {
			if !strings.Contains(command, want) {
				t.Errorf("%s 的解压命令缺少 %q:\n%s", tc.name, want, command)
			}
		}
		listAt := strings.Index(command, tc.list)
		extractAt := strings.Index(command, tc.extract)
		if listAt < 0 || extractAt < 0 || listAt > extractAt {
			t.Errorf("%s 必须先列出成员校验、再解压:\n%s", tc.name, command)
		}
	}

	command := extractCommand("/tmp/pkg.7z", "/tmp/target")
	for _, want := range []string{
		"tool=7z",
		`l -ba -slt '/tmp/pkg.7z'`,
		"grep -Eq",
		`^Path = `,
		`"$tool" x -y '/tmp/pkg.7z'`,
		"exit 127",
	} {
		if !strings.Contains(command, want) {
			t.Errorf("7z 解压命令缺少 %q:\n%s", want, command)
		}
	}
	listAt := strings.Index(command, "l -ba -slt")
	extractAt := strings.Index(command, "x -y")
	if listAt < 0 || extractAt < 0 || listAt > extractAt {
		t.Errorf("7z 必须先列出成员校验、再解压:\n%s", command)
	}
}

// 有 bash 与 tar 时直接执行生成的脚本：含 "../" 成员的 TAR 被拒绝，
// 正常 TAR 仍能解压。断言错误文案来自成员校验，确保不是 tar 自身拒绝。
func TestTarExtractScriptRejectsTraversal(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("未找到 bash，跳过脚本行为测试")
	}
	if _, err := exec.LookPath("tar"); err != nil {
		t.Skip("未找到 tar，跳过脚本行为测试")
	}

	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatalf("创建目标目录失败: %v", err)
	}
	// GNU tar 会把 "C:/..." 解释成 rsh 主机语法，测试里必须传 POSIX 形式路径
	run := func(archivePath string) (string, error) {
		command := extractCommand(toPosixPath(archivePath), toPosixPath(target))
		output, err := exec.Command(bash, "-c", command).CombinedOutput()
		return string(output), err
	}

	goodTar := filepath.Join(root, "good.tar")
	if err := writeTarEntries(goodTar, map[string]string{"dir/a.txt": "hello"}); err != nil {
		t.Fatalf("创建正常 TAR 失败: %v", err)
	}
	if output, err := run(goodTar); err != nil {
		t.Fatalf("正常 TAR 应能解压: %v, 输出: %s", err, output)
	}
	if data, err := os.ReadFile(filepath.Join(target, "dir", "a.txt")); err != nil || string(data) != "hello" {
		t.Fatalf("正常 TAR 解压结果错误: %v, 内容 %q", err, string(data))
	}

	evilTar := filepath.Join(root, "evil.tar")
	if err := writeTarEntries(evilTar, map[string]string{"../pwned.txt": "pwned"}); err != nil {
		t.Fatalf("创建恶意 TAR 失败: %v", err)
	}
	output, err := run(evilTar)
	if err == nil {
		t.Fatalf("含 ../ 成员的 TAR 应被拒绝，实际成功: %s", output)
	}
	if !strings.Contains(output, "非法路径成员") {
		t.Fatalf("TAR 未被成员校验拦截，输出: %s", output)
	}
	if _, err := os.Stat(filepath.Join(root, "pwned.txt")); err == nil {
		t.Fatal("路径穿越成员被写到了目标目录之外")
	}
}

// 生成的 tar/7z 脚本必须同时拒绝链接型成员：仅校验成员名挡不住
// "link -> /etc" + "link/passwd" 这类先建链接再借链接写到目录外的归档。
func TestExtractScriptRejectsLinkMembers(t *testing.T) {
	for _, name := range []string{"pkg.tar", "pkg.tar.gz", "pkg.tar.bz2", "pkg.tar.xz"} {
		command := extractCommand("/tmp/"+name, "/tmp/target")
		for _, want := range []string{"tar -tv", "^[lh]", "符号链接或硬链接"} {
			if !strings.Contains(command, want) {
				t.Errorf("%s 的解压命令缺少链接校验 %q:\n%s", name, want, command)
			}
		}
		linkAt := strings.Index(command, "tar -tv")
		extractAt := strings.LastIndex(command, "tar -x")
		if linkAt < 0 || extractAt < 0 || linkAt > extractAt {
			t.Errorf("%s 必须先校验链接成员、再解压:\n%s", name, command)
		}
	}

	command := extractCommand("/tmp/pkg.7z", "/tmp/target")
	for _, want := range []string{"^Symbolic Link = ", "符号链接或硬链接"} {
		if !strings.Contains(command, want) {
			t.Errorf("7z 解压命令缺少链接校验 %q:\n%s", want, command)
		}
	}
	linkAt := strings.Index(command, "^Symbolic Link = ")
	extractAt := strings.Index(command, "x -y")
	if linkAt < 0 || extractAt < 0 || linkAt > extractAt {
		t.Errorf("7z 必须先校验链接成员、再解压:\n%s", command)
	}
}

// 实际执行生成脚本：含符号链接成员的 TAR 必须被拒绝，且不在目标目录外落盘。
func TestTarExtractScriptRejectsSymlinkMembers(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("未找到 bash，跳过脚本行为测试")
	}
	if _, err := exec.LookPath("tar"); err != nil {
		t.Skip("未找到 tar，跳过脚本行为测试")
	}

	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatalf("创建目标目录失败: %v", err)
	}
	archivePath := filepath.Join(root, "link.tar")
	if err := writeSymlinkTar(archivePath, "link", "/etc"); err != nil {
		t.Fatalf("创建含链接的 TAR 失败: %v", err)
	}

	command := extractCommand(toPosixPath(archivePath), toPosixPath(target))
	output, err := exec.Command(bash, "-c", command).CombinedOutput()
	if err == nil {
		t.Fatalf("含符号链接成员的 TAR 应被拒绝，实际成功: %s", output)
	}
	if !strings.Contains(string(output), "符号链接或硬链接成员") {
		t.Fatalf("TAR 未被链接校验拦截，输出: %s", output)
	}
	if _, err := os.Lstat(filepath.Join(target, "link")); err == nil {
		t.Fatal("符号链接成员被解压到了目标目录")
	}
}

// writeSymlinkTar 生成只含一个符号链接成员的最小 TAR。
func writeSymlinkTar(p string, linkName string, linkTarget string) error {
	file, err := os.Create(p)
	if err != nil {
		return err
	}
	writer := tar.NewWriter(file)
	if err := writer.WriteHeader(&tar.Header{
		Name:     linkName,
		Mode:     0o777,
		Typeflag: tar.TypeSymlink,
		Linkname: linkTarget,
	}); err != nil {
		_ = file.Close()
		return err
	}
	if err := writer.Close(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

// toPosixPath 把 Windows 盘符路径转成 MSYS/Git Bash 可识别的 /c/... 形式；
// 其他平台原样返回。
func toPosixPath(p string) string {
	v := filepath.ToSlash(p)
	if runtime.GOOS != "windows" || len(v) < 3 || v[1] != ':' {
		return v
	}
	return "/" + strings.ToLower(v[:1]) + v[2:]
}

// writeTarEntries 生成一个最小 TAR（成员名原样写入，便于构造恶意路径）。
func writeTarEntries(p string, entries map[string]string) error {
	file, err := os.Create(p)
	if err != nil {
		return err
	}
	writer := tar.NewWriter(file)
	for name, content := range entries {
		header := &tar.Header{
			Name:     name,
			Mode:     0o644,
			Size:     int64(len(content)),
			Typeflag: tar.TypeReg,
		}
		if err := writer.WriteHeader(header); err != nil {
			_ = file.Close()
			return err
		}
		if _, err := writer.Write([]byte(content)); err != nil {
			_ = file.Close()
			return err
		}
	}
	if err := writer.Close(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}

// writeZipEntries 生成一个最小 ZIP（成员名原样写入，便于构造恶意路径）。
func writeZipEntries(path string, entries map[string]string) error {
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	writer := zip.NewWriter(file)
	for name, content := range entries {
		entry, err := writer.Create(name)
		if err != nil {
			_ = file.Close()
			return err
		}
		if _, err := entry.Write([]byte(content)); err != nil {
			_ = file.Close()
			return err
		}
	}
	if err := writer.Close(); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}
