// 目录压缩上传与远端解压。
//
// 上传大量小文件时，逐个握手/建目录的开销远大于传输本身；
// 这里在本地把目录打成一个 ZIP、单次上传，再在远端用 unzip/tar 展开，
// 最后删除临时压缩包。进度事件按压缩包字节数上报，前端只需一条传输记录。

package sftp

import (
	"archive/zip"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// 远端解压命令的超时：解压大归档可能需要较长时间，但不应无限挂起。
const extractTimeout = 10 * time.Minute

// shellQuote 把任意字符串包成 POSIX shell 单引号字面量。
// 单引号内除单引号本身外不做任何解释，是最安全的拼接方式。
func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// archiveTopName 返回压缩包内顶层目录名；路径异常时回退到 upload。
//
// ".." 必须被替换：若用户传入的本地路径本身就是 ".."，压缩包内会出现以 ".."
// 开头的成员名，解压时会被解释成目标目录之外（路径穿越）。这个压缩包不经过
// 成员校验（见 extractRemoteZip），只能在生成侧保证成员名合法。
func archiveTopName(localPath string) string {
	base := filepath.Base(localPath)
	if base == "" || base == "." || base == ".." || base == string(filepath.Separator) {
		return "upload"
	}
	return base
}

// zipLocalPath 把本地文件/目录压缩到 zipPath（不含符号链接，避免目录环）。
// 目录结构在压缩包内以顶层目录名保留，解压后即可还原原目录。
func zipLocalPath(localPath string, zipPath string) (int64, error) {
	out, err := os.OpenFile(zipPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return 0, fmt.Errorf("创建临时压缩包失败: %w", err)
	}
	// 任一步失败都要关闭并删除半截压缩包
	completed := false
	defer func() {
		_ = out.Close()
		if !completed {
			_ = os.Remove(zipPath)
		}
	}()

	writer := zip.NewWriter(out)
	top := archiveTopName(localPath)

	err = filepath.WalkDir(localPath, func(p string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		// 符号链接一律跳过：既不跟随也不打包，避免把目录外内容带进压缩包
		if info.Mode()&os.ModeSymlink != 0 {
			return nil
		}

		rel, err := filepath.Rel(localPath, p)
		if err != nil {
			return err
		}
		zipName := top
		if rel != "." {
			zipName = path.Join(top, filepath.ToSlash(rel))
		}

		header := &zip.FileHeader{
			Name:     zipName,
			Method:   zip.Deflate,
			Modified: info.ModTime(),
		}
		if info.IsDir() {
			header.Name += "/"
			header.Method = zip.Store
			header.SetMode(os.ModeDir | info.Mode().Perm())
			_, err := writer.CreateHeader(header)
			return err
		}

		header.SetMode(info.Mode().Perm())
		dst, err := writer.CreateHeader(header)
		if err != nil {
			return err
		}
		src, err := os.Open(p)
		if err != nil {
			return fmt.Errorf("读取本地文件 %q 失败: %w", p, err)
		}
		defer src.Close()
		if _, err := io.Copy(dst, src); err != nil {
			return fmt.Errorf("写入压缩包条目 %q 失败: %w", zipName, err)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	if err := writer.Close(); err != nil {
		return 0, fmt.Errorf("完成压缩包写入失败: %w", err)
	}
	if err := out.Close(); err != nil {
		return 0, fmt.Errorf("关闭临时压缩包失败: %w", err)
	}
	completed = true

	stat, err := os.Stat(zipPath)
	if err != nil {
		return 0, fmt.Errorf("读取压缩包大小失败: %w", err)
	}
	return stat.Size(), nil
}

// UploadDirArchive 把本地文件/目录打包上传到 remoteDir 并立即解压。
// remoteDir 不存在时自动创建；临时压缩包在解压后删除（失败时也尽力清理）。
func (s *SftpService) UploadDirArchive(sessionID string, transferID string, localPath string, remoteDir string) error {
	ctx, done := s.registerTransfer(transferID)
	defer done()

	cleanLocal := strings.TrimSpace(localPath)
	if cleanLocal == "" {
		err := errors.New("本地路径不能为空")
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}
	if _, err := os.Stat(cleanLocal); err != nil {
		message := fmt.Sprintf("读取本地路径失败: %v", err)
		s.emitter.EmitTransferComplete(sessionID, transferID, false, message)
		return fmt.Errorf("读取本地路径 %q 失败: %w", cleanLocal, err)
	}

	targetDir := path.Clean(strings.TrimSpace(remoteDir))
	if targetDir == "" || targetDir == "." {
		targetDir = "/"
	}

	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}
	if err := client.MkdirAll(targetDir); err != nil {
		message := fmt.Sprintf("创建远端目录失败: %v", err)
		s.emitter.EmitTransferComplete(sessionID, transferID, false, message)
		return fmt.Errorf("创建远端目录 %q 失败: %w", targetDir, err)
	}

	tempZip, err := os.CreateTemp("", "terminator-upload-*.zip")
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return fmt.Errorf("创建临时压缩包失败: %w", err)
	}
	zipPath := tempZip.Name()
	_ = tempZip.Close()
	defer os.Remove(zipPath)

	zipSize, err := zipLocalPath(cleanLocal, zipPath)
	if err != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return err
	}

	displayName := archiveTopName(cleanLocal) + ".zip"
	remoteArchive := path.Join(targetDir, fmt.Sprintf(".terminator-upload-%d.zip", time.Now().UnixNano()))

	if zipSize > 0 {
		s.emitter.EmitTransferProgress(sessionID, transferID, displayName, 0, zipSize)
	}
	if err := s.uploadOne(
		ctx, client, sessionID, transferID,
		zipPath, remoteArchive, displayName,
		zipSize, 0,
	); err != nil {
		_ = client.Remove(remoteArchive)
		// uploadOne 失败时会保留续传用的 part 文件；临时压缩包名带时间戳，
		// 下次上传不会命中断点，必须一并删除，否则目标目录里会留下整份残留。
		// part 名包含源端修改时间与传输 ID，这里按同样的输入重建名称。
		zipModTime := time.Time{}
		if info, statErr := os.Stat(zipPath); statErr == nil {
			zipModTime = info.ModTime()
		}
		_ = client.Remove(partPath(remoteArchive, zipSize, transferIdentity(zipModTime, transferID)))
		s.emitter.EmitTransferComplete(sessionID, transferID, false, err.Error())
		return fmt.Errorf("上传压缩包失败: %w", err)
	}
	// 上传完成即视为 100%：解压阶段不再有字节进度
	if zipSize > 0 {
		s.emitter.EmitTransferProgress(sessionID, transferID, displayName, zipSize, zipSize)
	}

	extractErr := s.extractRemoteZip(sessionID, remoteArchive, targetDir)
	_ = client.Remove(remoteArchive)
	if extractErr != nil {
		s.emitter.EmitTransferComplete(sessionID, transferID, false, extractErr.Error())
		return extractErr
	}
	s.emitter.EmitTransferComplete(sessionID, transferID, true, "")
	return nil
}

// extractRemoteZip 在远端解压 ZIP 到目标目录：
// 优先使用 unzip（几乎所有 Linux 发行版都有），缺失时退回 Python 标准库。
//
// 这里不做成员路径预检：压缩包由本机 zipLocalPath 生成，成员名全部来自本地
// 文件系统（不含 ".." 段，也不可能以 "/" 开头），不存在路径穿越。
// 用户自选压缩包走 ExtractArchive，那里会先校验再解压。
func (s *SftpService) extractRemoteZip(sessionID string, archivePath string, targetDir string) error {
	command := fmt.Sprintf(
		"cd %s && if command -v unzip >/dev/null 2>&1; then unzip -o -q %s; "+
			"elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e %s .; "+
			"else echo '远端缺少 unzip 与 python3，无法解压' >&2; exit 127; fi",
		shellQuote(targetDir), shellQuote(archivePath), shellQuote(archivePath),
	)
	output, err := s.sshSvc.ExecCommand(sessionID, command, extractTimeout)
	if err != nil {
		detail := strings.TrimSpace(output)
		if detail == "" {
			detail = err.Error()
		}
		return fmt.Errorf("远端解压失败: %s", detail)
	}
	return nil
}

// isSingleFileGzip 判断压缩包是否为"就地解压的单文件 .gz"。
// 必须排除 .tar.gz / .tgz：它们同样以 .gz 结尾，若当成单文件 gzip 处理，
// gzip -d 只会把 foo.tar.gz 解成 foo.tar 并删掉原包，目录既不创建也不展开，
// 命令退出码为 0，会被误判成解压成功。
func isSingleFileGzip(archivePath string) bool {
	name := strings.ToLower(path.Base(archivePath))
	if strings.HasSuffix(name, ".tar.gz") || strings.HasSuffix(name, ".tgz") {
		return false
	}
	return strings.HasSuffix(name, ".gz")
}

// unsafeMemberPattern 匹配绝对路径或含 ".." 段的成员名。
// 供 ZIP / TAR / 7z 的成员列表 grep 校验使用；POSIX 括号表达式里反斜杠是
// 普通字符，因此同时覆盖 "/" 与 "\" 两种分隔符写法。
const unsafeMemberPattern = `^/|(^|[/\\])\.\.([/\\]|$)`

// pythonZipMemberCheck 校验 ZIP 成员路径：列出全部成员后拒绝绝对路径（以 "/" 开头）
// 与包含 ".." 段的成员，失败原因直接写 stderr（由 ExecCommand 汇总上报）。
//
// 这段代码会被 shellQuote 包进单引号，因此内部不能出现单引号（只用双引号字符串）。
// 反斜杠也按分隔符处理：部分解压实现会把 "\" 解释成目录分隔。
const pythonZipMemberCheck = `import sys, zipfile
try:
    infos = zipfile.ZipFile(sys.argv[1]).infolist()
except Exception as exc:
    sys.stderr.write("压缩包无法读取（文件损坏或不是 ZIP 格式）: %s\n" % exc)
    sys.exit(2)
names = [i.filename for i in infos]
bad = [n for n in names if n.startswith("/") or ".." in n.replace("\\", "/").split("/")]
if bad:
    sys.stderr.write("压缩包包含非法路径成员（以 / 开头或含 .. 段），已中止解压\n")
    sys.exit(3)
# 仅校验名字挡不住链接型成员：看似合法的 "link" 若指向 /etc，随后 "link/passwd"
# 就会写到目标目录之外。unzip 会还原 ZIP 中的符号链接（external_attr 高 16 位
# 记录 Unix 模式），因此链接条目一律拒绝，改用普通文件重新打包。
links = [i.filename for i in infos if (i.external_attr >> 16) & 0o170000 == 0o120000]
if links:
    sys.stderr.write("压缩包包含符号链接条目，可能写到目标目录之外，已中止解压\n")
    sys.exit(4)
sys.exit(0)
`

// unsafe7zPathPattern 匹配 7z -slt 输出中的 Path 行（绝对路径或含 ".." 段）。
// 7z 的普通列表（-ba）是「日期 时间 属性 大小 …」的多列表格，成员名不是行首，
// 直接复用 unsafeMemberPattern 会漏掉行中间的 "../"。-slt 会逐字段输出
// "Path = <成员名>"，必须把前缀一并写进正则，才能让行首锚点生效。
// 必须与 -ba 同时使用：-ba 去掉压缩包自身的头部信息块（否则第一行
// "Path = <压缩包绝对路径>" 会命中行首的 "/" 而误报非法成员）。
const unsafe7zPathPattern = `^Path = (/|\.\.([/\\]|$)|.*[/\\]\.\.([/\\]|$))`

// guardedExtractScript 生成"先列出成员并校验路径，再执行解压"的命令。
// listCommand 输出成员名（一行一个），extractCommand 执行真正的解压。
// 任一步缺工具或列表读取失败都中止：宁可不解压，也不能跳过校验
// （tar / 7z 的部分实现会接受 "../" 或绝对路径成员，写到目标目录之外）。
func guardedExtractScript(targetDir string, listCommand string, extractCommand string, memberPattern string) string {
	badName := shellQuote("压缩包包含非法路径成员（以 / 开头或含 .. 段），已中止解压")
	noList := shellQuote("无法读取压缩包成员列表（缺少解压工具或压缩包已损坏），已中止解压")
	noTemp := shellQuote("无法创建临时文件，已中止解压")
	noGrep := shellQuote("远端缺少 grep，无法校验压缩包成员路径，已中止解压")

	return "cd " + shellQuote(targetDir) + " || exit 1; " +
		"command -v grep >/dev/null 2>&1 || { echo " + noGrep + " >&2; exit 1; }; " +
		"tmp=$(mktemp 2>/dev/null) || tmp=$(mktemp -t terminator-archive 2>/dev/null) || { echo " + noTemp + " >&2; exit 1; }; " +
		"if ! " + listCommand + ` > "$tmp" 2>/dev/null; then rm -f "$tmp"; echo ` + noList + " >&2; exit 1; fi; " +
		"if grep -Eq " + shellQuote(memberPattern) + ` "$tmp"; then rm -f "$tmp"; echo ` + badName + " >&2; exit 1; fi; " +
		`rm -f "$tmp"; ` + extractCommand
}

// zipExtractScript 生成"先校验成员路径、再解压"的远端 ZIP 解压命令。
//
// unzip 与 python3 -m zipfile 都不会拒绝 "../" 或绝对路径成员，恶意压缩包
// 可以把文件写到目标目录之外、覆盖用户的其它文件。因此先列出全部成员：
// 有 python3 时用标准库校验（能准确区分非法成员与损坏文件），只有 unzip 时
// 用 -Z1 列成员再用 grep 校验，并用 zipinfo 长格式拒绝链接型成员；
// 两者都无法给出成员列表时宁可中止，也不跳过校验直接解压（fail-closed）。
func zipExtractScript(archivePath string, targetDir string) string {
	archive := shellQuote(archivePath)
	// 与 pythonZipMemberCheck 同一语义：以 "/" 开头，或出现被 "/"、"\"
	// 包围的 ".." 段。
	badName := shellQuote("压缩包包含非法路径成员（以 / 开头或含 .. 段），已中止解压")
	noList := shellQuote("远端 unzip 无法列出压缩包成员（不支持 -Z 或压缩包已损坏），已中止解压")
	noTemp := shellQuote("无法创建临时文件，已中止解压")
	noGrep := shellQuote("远端缺少 grep，无法校验压缩包成员路径，已中止解压")
	noTool := shellQuote("远端缺少 unzip 与 python3，无法解压")
	// 无 python3 时链接成员只能靠 zipinfo 长格式识别（首列为类型字符）。
	// 缺少该能力时保持 fail-closed，避免"link -> /etc" + "link/passwd" 逃逸。
	noLinkList := shellQuote("远端 unzip 无法列出成员属性（缺少 zipinfo 且不支持 -Z 模式），已中止解压")
	badLink := shellQuote("压缩包包含符号链接条目，可能写到目标目录之外，已中止解压")

	return "cd " + shellQuote(targetDir) + " || exit 1; " +
		"if command -v python3 >/dev/null 2>&1; then " +
		"python3 -c " + shellQuote(pythonZipMemberCheck) + " " + archive + " || exit 1; " +
		"elif command -v unzip >/dev/null 2>&1; then " +
		"command -v grep >/dev/null 2>&1 || { echo " + noGrep + " >&2; exit 1; }; " +
		"tmp=$(mktemp 2>/dev/null) || tmp=$(mktemp -t terminator-zip 2>/dev/null) || { echo " + noTemp + " >&2; exit 1; }; " +
		"if ! unzip -Z1 " + archive + ` > "$tmp" 2>/dev/null; then rm -f "$tmp"; echo ` + noList + " >&2; exit 1; fi; " +
		"if grep -Eq " + shellQuote(unsafeMemberPattern) + ` "$tmp"; then rm -f "$tmp"; echo ` + badName + " >&2; exit 1; fi; " +
		"if command -v zipinfo >/dev/null 2>&1; then " +
		`zipinfo ` + archive + ` > "$tmp" 2>/dev/null || { rm -f "$tmp"; echo ` + noLinkList + " >&2; exit 1; }; " +
		`elif unzip -Z ` + archive + ` > "$tmp" 2>/dev/null; then :; ` +
		`else rm -f "$tmp"; echo ` + noLinkList + " >&2; exit 1; fi; " +
		`if grep -Eq "^l" "$tmp"; then rm -f "$tmp"; echo ` + badLink + " >&2; exit 1; fi; " +
		`rm -f "$tmp"; ` +
		"fi; " +
		"if command -v unzip >/dev/null 2>&1; then unzip -o -q " + archive + "; " +
		"elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e " + archive + " .; " +
		"else echo " + noTool + " >&2; exit 127; fi"
}

// extractCommand 按扩展名选择远端解压命令；返回空字符串表示不支持该格式。
func extractCommand(archivePath string, targetDir string) string {
	name := strings.ToLower(path.Base(archivePath))
	quotedArchive := shellQuote(archivePath)
	prefix := "cd " + shellQuote(targetDir) + " && "

	switch {
	case strings.HasSuffix(name, ".zip"):
		return zipExtractScript(archivePath, targetDir)
	case strings.HasSuffix(name, ".tar.gz"), strings.HasSuffix(name, ".tgz"):
		return guardedExtractScript(targetDir, "tar -tzf "+quotedArchive, "tar -xzf "+quotedArchive, unsafeMemberPattern)
	case strings.HasSuffix(name, ".tar.bz2"), strings.HasSuffix(name, ".tbz2"):
		return guardedExtractScript(targetDir, "tar -tjf "+quotedArchive, "tar -xjf "+quotedArchive, unsafeMemberPattern)
	case strings.HasSuffix(name, ".tar.xz"), strings.HasSuffix(name, ".txz"):
		return guardedExtractScript(targetDir, "tar -tJf "+quotedArchive, "tar -xJf "+quotedArchive, unsafeMemberPattern)
	case strings.HasSuffix(name, ".tar"):
		return guardedExtractScript(targetDir, "tar -tf "+quotedArchive, "tar -xf "+quotedArchive, unsafeMemberPattern)
	case strings.HasSuffix(name, ".7z"):
		// 7z 的普通列表由多列组成，成员名不在行首，必须用 -slt 逐字段输出，
		// 才能对 "Path = ..." 做行首锚定的路径校验（见 unsafe7zPathPattern）。
		var listCommand, extractCommand string
		listCommand = `"$tool" l -ba -slt ` + quotedArchive
		extractCommand = `"$tool" x -y ` + quotedArchive + ` >/dev/null`
		return "if command -v 7z >/dev/null 2>&1; then tool=7z; " +
			"elif command -v 7za >/dev/null 2>&1; then tool=7za; " +
			"else echo '远端缺少 7z，无法解压' >&2; exit 127; fi; " +
			guardedExtractScript(targetDir, listCommand, extractCommand, unsafe7zPathPattern)
	case strings.HasSuffix(name, ".gz"):
		// 单文件 gzip：只解压出同名文件，不支持"解压到目录"
		return prefix + "gzip -d -f " + quotedArchive
	default:
		return ""
	}
}

// ExtractArchive 在远端解压一个压缩包到 remoteDir（自动创建目录）。
func (s *SftpService) ExtractArchive(sessionID string, remoteArchivePath string, remoteDir string) error {
	archivePath := strings.TrimSpace(remoteArchivePath)
	if archivePath == "" {
		return errors.New("压缩包路径不能为空")
	}
	targetDir := path.Clean(strings.TrimSpace(remoteDir))
	if targetDir == "" || targetDir == "." {
		targetDir = "/"
	}

	client, err := s.sshSvc.GetSFTPClient(sessionID)
	if err != nil {
		return err
	}
	info, err := client.Stat(archivePath)
	if err != nil {
		return fmt.Errorf("读取压缩包 %q 失败: %w", archivePath, err)
	}
	if info.IsDir() {
		return errors.New("目标是目录，不是压缩包")
	}

	command := extractCommand(archivePath, targetDir)
	if command == "" {
		return errors.New("不支持的压缩格式（支持 zip / tar / tar.gz / tar.bz2 / tar.xz / 7z / gz）")
	}
	// gzip 只解压单文件，忽略目标目录
	if isSingleFileGzip(archivePath) {
		dir := path.Dir(archivePath)
		command = "cd " + shellQuote(dir) + " && gzip -d -f " + shellQuote(archivePath)
	} else if err := client.MkdirAll(targetDir); err != nil {
		return fmt.Errorf("创建远端目录 %q 失败: %w", targetDir, err)
	}

	output, err := s.sshSvc.ExecCommand(sessionID, command, extractTimeout)
	if err != nil {
		detail := strings.TrimSpace(output)
		if detail == "" {
			detail = err.Error()
		}
		return fmt.Errorf("解压失败: %s", detail)
	}
	return nil
}
