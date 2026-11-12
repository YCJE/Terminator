package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

// downloadIdleTimeout 是下载过程中两次收到数据之间的最长间隔。
// 服务器返回响应头后停止发送数据（黑洞连接、被劫持的代理）时，resp.Body.Read
// 会一直阻塞到 30 分钟总超时，设置页只能干等且无法重新发起下载。
const downloadIdleTimeout = 30 * time.Second

// idleCancelReader 在连续 idle 时间内没有收到任何数据时取消请求。
// http 的响应体读取会响应请求上下文取消，从而让阻塞中的 Read 尽快返回。
type idleCancelReader struct {
	r       io.Reader
	idle    time.Duration
	timer   *time.Timer
	cancel  context.CancelFunc
	idleHit atomic.Bool
}

func newIdleCancelReader(r io.Reader, idle time.Duration, cancel context.CancelFunc) *idleCancelReader {
	w := &idleCancelReader{r: r, idle: idle, cancel: cancel}
	w.timer = time.AfterFunc(idle, func() {
		w.idleHit.Store(true)
		cancel()
	})
	return w
}

func (w *idleCancelReader) Read(p []byte) (int, error) {
	n, err := w.r.Read(p)
	if n > 0 {
		// 收到数据即重置计时；Reset 与定时器触发并发时只会多取消一次，无副作用
		w.timer.Reset(w.idle)
	}
	return n, err
}

func (w *idleCancelReader) Close() error {
	w.timer.Stop()
	if c, ok := w.r.(io.Closer); ok {
		return c.Close()
	}
	return nil
}

// timedOut 返回是否因空闲超时被取消（用于区分用户/系统取消与网络停滞）。
func (w *idleCancelReader) timedOut() bool {
	return w.idleHit.Load()
}

// ReleaseAsset GitHub Release 中的可下载资产。
type ReleaseAsset struct {
	Name        string `json:"name"`
	DownloadURL string `json:"browser_download_url"`
	Size        int64  `json:"size"`
	// ID GitHub 资产 ID。部分网络环境下 github.com 下载域名不可达，
	// 而 api.github.com 及其重定向到的 release-assets.githubusercontent.com 可达，
	// 因此下载优先走 API 资产端点，browser_download_url 仅作兜底。
	ID int64 `json:"id"`
}

// githubRelease releases/latest 接口返回字段的子集。
type githubRelease struct {
	TagName     string         `json:"tag_name"`
	PublishedAt string         `json:"published_at"`
	Body        string         `json:"body"`
	HtmlURL     string         `json:"html_url"`
	Assets      []ReleaseAsset `json:"assets"`
}

// fetchLatestRelease 拉取最新 Release 元数据。
func (s *UpdaterService) fetchLatestRelease() (*githubRelease, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", s.githubRepo)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("创建请求失败: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求 GitHub API 失败: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API 返回状态码: %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, fmt.Errorf("读取响应失败: %w", err)
	}

	var release githubRelease
	if err := json.Unmarshal(body, &release); err != nil {
		return nil, fmt.Errorf("解析响应失败: %w", err)
	}
	return &release, nil
}

// checksumOSName 返回与发布流程约定的平台标识。
func checksumOSName() string {
	switch runtime.GOOS {
	case "windows":
		return "windows"
	case "darwin":
		return "macos"
	default:
		return "linux"
	}
}

// checksumAssetName 校验和清单文件名，必须与 CI 生成的文件名保持一致。
func checksumAssetName() string {
	return fmt.Sprintf("SHA256SUMS-%s.txt", checksumOSName())
}

// findAsset 按名称（不区分大小写）查找发布资产。
func findAsset(assets []ReleaseAsset, name string) *ReleaseAsset {
	for i := range assets {
		if strings.EqualFold(assets[i].Name, name) {
			return &assets[i]
		}
	}
	return nil
}

// findInstallerAsset 选择当前平台的安装包资产。
//
// 按平台特征后缀匹配，避免误选 RELEASES、*.nupkg 等元数据文件。
// 发布流程用 --merge 累积资产，同一 Release 可能同时存在多个版本的安装包，
// 因此优先选择文件名包含当前版本号的资产，匹配不到再退回任意版本。
func findInstallerAsset(assets []ReleaseAsset, version string) *ReleaseAsset {
	var suffixes []string
	switch runtime.GOOS {
	case "windows":
		suffixes = []string{"Setup.exe"}
	case "darwin":
		suffixes = []string{".dmg", ".pkg"}
	default:
		suffixes = []string{".AppImage", ".deb", ".rpm"}
	}

	if version != "" {
		for _, suffix := range suffixes {
			for i := range assets {
				if strings.HasSuffix(assets[i].Name, suffix) && assetNameHasVersion(assets[i].Name, version) {
					return &assets[i]
				}
			}
		}
	}
	for _, suffix := range suffixes {
		for i := range assets {
			if strings.HasSuffix(assets[i].Name, suffix) {
				return &assets[i]
			}
		}
	}
	return nil
}

// assetNameHasVersion 判断资产名是否包含完整版本号。
//
// 不能用 strings.Contains：1.2.3 会命中 1.2.30 的安装包，用户更新到的是
// 另一个版本；真正的 1.2.3 资产反而从未被选中。版本号两侧必须不是数字或
// 小数点才算完整匹配（分隔符如 "-"、"v"、"_" 均可）。
func assetNameHasVersion(name string, version string) bool {
	isVersionChar := func(b byte) bool {
		return (b >= '0' && b <= '9') || b == '.'
	}
	for start := 0; start+len(version) <= len(name); {
		idx := strings.Index(name[start:], version)
		if idx < 0 {
			return false
		}
		pos := start + idx
		end := pos + len(version)
		beforeOK := pos == 0 || !isVersionChar(name[pos-1])
		afterOK := end == len(name) || !isVersionChar(name[end])
		if beforeOK && afterOK {
			return true
		}
		start = pos + 1
	}
	return false
}

// assetURLs 返回资产的候选下载地址，按成功率从高到低排列。
// API 资产端点（Accept: application/octet-stream）会 302 到 GitHub 的对象存储，
// 在 github.com 被限速或阻断的网络里通常仍可用；没有资产 ID 时才只能走原地址。
func (s *UpdaterService) assetURLs(asset ReleaseAsset) []string {
	urls := make([]string, 0, 2)
	if asset.ID > 0 {
		urls = append(urls, fmt.Sprintf("https://api.github.com/repos/%s/releases/assets/%d", s.githubRepo, asset.ID))
	}
	if asset.DownloadURL != "" {
		urls = append(urls, asset.DownloadURL)
	}
	return urls
}

// fetchChecksums 下载并解析校验和清单，返回 文件名 → 小写 SHA256 的映射。
// 清单格式为 sha256sum 输出：<64 位十六进制>  <文件名>，兼容二进制的 "*文件名" 形式。
// 依次尝试候选地址，任一成功即返回。
func (s *UpdaterService) fetchChecksums(asset ReleaseAsset) (map[string]string, error) {
	var lastErr error
	for _, url := range s.assetURLs(asset) {
		sums, err := s.fetchChecksumsFrom(url)
		if err == nil {
			return sums, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		return nil, fmt.Errorf("校验和资产缺少可用的下载地址")
	}
	return nil, lastErr
}

func (s *UpdaterService) fetchChecksumsFrom(url string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	// 走 API 端点时该头表示「下载资产内容」；走原地址时会被忽略
	req.Header.Set("Accept", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("校验和下载失败，状态码: %d", resp.StatusCode)
	}

	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}

	sums := make(map[string]string)
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		name := strings.TrimPrefix(fields[1], "*")
		name = strings.TrimPrefix(name, "./")
		sums[name] = strings.ToLower(fields[0])
	}
	return sums, nil
}

// DownloadAndVerifyUpdate 下载当前平台安装包并校验 SHA256。
//
// 校验和取自发布资产中的平台校验和清单；校验失败会删除已下载文件并返回错误，
// 避免用户执行被篡改或损坏的安装包。校验通过后返回本地文件路径。
func (s *UpdaterService) DownloadAndVerifyUpdate() (string, error) {
	s.mu.Lock()
	if s.manualDownloading {
		s.mu.Unlock()
		return "", ErrDownloadInProgress
	}
	s.manualDownloading = true
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.manualDownloading = false
		s.mu.Unlock()
	}()

	release, err := s.fetchLatestRelease()
	if err != nil {
		return "", err
	}

	installer := findInstallerAsset(release.Assets, normalizeVersion(release.TagName))
	if installer == nil {
		return "", fmt.Errorf("发布中未找到适用于当前平台的安装包")
	}

	// 资产名来自远端 Release，不能直接拼进本地路径：Windows 上合法的 `\` 与 `..`
	// 会让 filepath.Join 归一化后逃出缓存目录（如 "..\\..\\AppData\\..\\xSetup.exe"
	// 既满足 "Setup.exe" 后缀匹配，又能覆盖任意本地文件）。校验和同样取自该
	// Release，无法提供额外保护，因此必须在此拒绝可疑名称。
	installerName := filepath.Base(installer.Name)
	if installerName != installer.Name || installerName == "." || installerName == ".." ||
		strings.ContainsAny(installerName, "/\\") {
		return "", fmt.Errorf("发布资产名不合法，拒绝下载: %q", installer.Name)
	}

	checksumAsset := findAsset(release.Assets, checksumAssetName())
	if checksumAsset == nil {
		return "", fmt.Errorf("发布中缺少校验和文件 %s，无法验证安装包完整性", checksumAssetName())
	}

	sums, err := s.fetchChecksums(*checksumAsset)
	if err != nil {
		return "", fmt.Errorf("获取校验和失败: %w", err)
	}
	expected, ok := sums[installer.Name]
	if !ok {
		return "", fmt.Errorf("校验和清单中缺少 %s 的记录", installer.Name)
	}

	cacheDir, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(cacheDir, "Terminator", "updates")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}

	dst := filepath.Join(dir, installerName)
	// 先写 .part，校验通过后再改名，避免半成品被误当作可用安装包
	tmp := dst + ".part"

	actual, err := s.downloadFromCandidates(*installer, tmp)
	if err != nil {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("下载安装包失败: %w", err)
	}

	if !strings.EqualFold(actual, expected) {
		_ = os.Remove(tmp)
		return "", fmt.Errorf("安装包完整性校验失败：期望 %s，实际 %s（已删除下载文件）", expected, actual)
	}

	if err := os.Rename(tmp, dst); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}

	s.mu.Lock()
	s.verifiedPath = dst
	s.mu.Unlock()

	return dst, nil
}

// downloadFromCandidates 依次尝试候选地址下载安装包，任一成功即返回摘要。
// 失败时保留 .part 会被下一个地址以 O_TRUNC 覆盖，不会残留半成品。
func (s *UpdaterService) downloadFromCandidates(asset ReleaseAsset, dst string) (string, error) {
	var lastErr error
	for _, url := range s.assetURLs(asset) {
		sum, err := s.downloadWithProgress(url, dst)
		if err == nil {
			return sum, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		return "", fmt.Errorf("安装包资产缺少可用的下载地址")
	}
	return "", lastErr
}

// downloadWithProgress 将 url 下载到 dst，边下载边计算 SHA256，返回十六进制摘要。
// 通过 emitter 上报百分比；服务器未返回内容长度时不报进度。
func (s *UpdaterService) downloadWithProgress(url, dst string) (string, error) {
	// 安装包可达数百 MB，超时给足，避免慢速网络下中途失败
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	// 走 API 端点时该头表示「下载资产内容」；走原地址时会被忽略
	req.Header.Set("Accept", "application/octet-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	body := newIdleCancelReader(resp.Body, downloadIdleTimeout, cancel)
	defer func() { _ = body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("下载失败，状态码: %d", resp.StatusCode)
	}

	f, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return "", err
	}
	defer func() { _ = f.Close() }()

	hasher := sha256.New()
	total := resp.ContentLength
	var written int64
	lastPercent := uint(101) // 哨兵值，保证首个百分比一定被上报
	buf := make([]byte, 128*1024)

	for {
		n, readErr := body.Read(buf)
		if n > 0 {
			if _, wErr := f.Write(buf[:n]); wErr != nil {
				return "", wErr
			}
			_, _ = hasher.Write(buf[:n])
			written += int64(n)
			if total > 0 {
				percent := uint(written * 100 / total)
				// Content-Length 与实际写入量可能不一致（分块/压缩/代理改写），
				// 超过 100 会让进度条越界
				if percent > 100 {
					percent = 100
				}
				if percent != lastPercent {
					lastPercent = percent
					s.emitter.EmitProgress(percent)
				}
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			// 空闲看门狗取消请求时，Read 只会返回笼统的 context canceled；
			// 换成可诊断的提示，便于用户判断是网络停滞而非应用故障。
			if body.timedOut() {
				return "", fmt.Errorf("下载超时：服务器在 %s 内没有发送数据", downloadIdleTimeout)
			}
			return "", readErr
		}
	}

	if err := f.Sync(); err != nil {
		return "", err
	}
	// Close 可能返回延迟的写入错误（磁盘配额、远端存储异常）。
	// 若忽略，调用方会把写不完整的 .part 当作校验通过的文件重命名，
	// 用户执行安装包时才发现损坏，且已无法重新下载校验。
	if err := f.Close(); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// OpenVerifiedDownload 用系统默认程序打开最近一次校验通过的安装包。
//
// 仅打开本服务记录的文件，不接受前端传入的任意路径，
// 避免该接口被用作启动任意程序的通道。
func (s *UpdaterService) OpenVerifiedDownload() error {
	s.mu.Lock()
	path := s.verifiedPath
	s.mu.Unlock()

	if path == "" {
		return fmt.Errorf("没有已下载并校验的安装包")
	}
	if _, err := os.Stat(path); err != nil {
		return fmt.Errorf("安装包不存在: %w", err)
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
