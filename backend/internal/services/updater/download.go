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
	"time"
)

// ReleaseAsset GitHub Release 中的可下载资产。
type ReleaseAsset struct {
	Name        string `json:"name"`
	DownloadURL string `json:"browser_download_url"`
	Size        int64  `json:"size"`
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
				if strings.HasSuffix(assets[i].Name, suffix) && strings.Contains(assets[i].Name, version) {
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

// fetchChecksums 下载并解析校验和清单，返回 文件名 → 小写 SHA256 的映射。
// 清单格式为 sha256sum 输出：<64 位十六进制>  <文件名>，兼容二进制的 "*文件名" 形式。
func (s *UpdaterService) fetchChecksums(url string) (map[string]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
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

	checksumAsset := findAsset(release.Assets, checksumAssetName())
	if checksumAsset == nil {
		return "", fmt.Errorf("发布中缺少校验和文件 %s，无法验证安装包完整性", checksumAssetName())
	}

	sums, err := s.fetchChecksums(checksumAsset.DownloadURL)
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

	dst := filepath.Join(dir, installer.Name)
	// 先写 .part，校验通过后再改名，避免半成品被误当作可用安装包
	tmp := dst + ".part"

	actual, err := s.downloadWithProgress(installer.DownloadURL, tmp)
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
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()

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
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, wErr := f.Write(buf[:n]); wErr != nil {
				return "", wErr
			}
			_, _ = hasher.Write(buf[:n])
			written += int64(n)
			if total > 0 {
				percent := uint(written * 100 / total)
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
			return "", readErr
		}
	}

	if err := f.Sync(); err != nil {
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
