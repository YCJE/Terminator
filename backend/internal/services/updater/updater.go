package updater

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"runtime"
	"runtime/debug"
	"sync"
	"time"

	"github.com/quaadgras/velopack-go/velopack"
)

type Emitter interface {
	EmitProgress(percent uint)
}

type UpdateInfo struct {
	IsAvailable bool   `json:"isAvailable"`
	Version     string `json:"version"`
}

// GitHubReleaseInfo GitHub Release 信息
type GitHubReleaseInfo struct {
	HasUpdate    bool   `json:"hasUpdate"`
	LatestVersion string `json:"latestVersion"`
	CurrentVersion string `json:"currentVersion"`
	PublishedAt  string `json:"publishedAt"`
	ReleaseNotes string `json:"releaseNotes"`
	HtmlURL      string `json:"htmlUrl"`
}

// updaterState 更新器内部状态机
type updaterState int

const (
	stateIdle      updaterState = iota // 空闲，未检查
	stateChecked                      // 已检查，有待下载更新
	stateDownloaded                    // 已下载，待应用
)

type UpdaterService struct {
	updateURL string
	githubRepo string
	emitter   Emitter
	manager   *velopack.UpdateManager
	latest    *velopack.UpdateInfo
	state     updaterState
	mu        sync.Mutex
	// cgoUnavailable 标记 cgo 是否可用，避免反复尝试创建 manager
	cgoUnavailable bool
}

// Version 在构建时通过 -ldflags="-X ...updater.Version=v1.0.0" 注入
// 默认 "dev" 表示开发构建
var Version = "dev"

func NewUpdaterService(updateURL string, githubRepo string, emitter Emitter) *UpdaterService {
	return &UpdaterService{
		updateURL:  updateURL,
		githubRepo: githubRepo,
		emitter:    emitter,
		state:      stateIdle,
	}
}

// getCurrentVersion 获取当前应用版本号
// 优先使用构建时注入的 Version 变量，其次从 debug.ReadBuildInfo 获取
func (s *UpdaterService) getCurrentVersion() string {
	if Version != "dev" && Version != "" {
		return Version
	}
	if info, ok := debug.ReadBuildInfo(); ok {
		if info.Main.Version != "" && info.Main.Version != "(devel)" {
			return info.Main.Version
		}
	}
	return "dev"
}

// CheckGitHubReleases 通过 GitHub API 检查最新 Release
func (s *UpdaterService) CheckGitHubReleases() (*GitHubReleaseInfo, error) {
	currentVersion := s.getCurrentVersion()

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
		resp.Body.Close()
	}()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API 返回状态码: %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20)) // 限制 2MB
	if err != nil {
		return nil, fmt.Errorf("读取响应失败: %w", err)
	}

	var release struct {
		TagName     string `json:"tag_name"`
		PublishedAt string `json:"published_at"`
		Body        string `json:"body"`
		HtmlURL     string `json:"html_url"`
	}
	if err := json.Unmarshal(body, &release); err != nil {
		return nil, fmt.Errorf("解析响应失败: %w", err)
	}

	latestVersion := normalizeVersion(release.TagName)
	// 开发构建（"dev"）无法判断版本，默认提示有更新
	hasUpdate := currentVersion == "dev" || compareVersions(latestVersion, normalizeVersion(currentVersion)) > 0

	return &GitHubReleaseInfo{
		HasUpdate:     hasUpdate,
		LatestVersion: latestVersion,
		CurrentVersion: currentVersion,
		PublishedAt:   release.PublishedAt,
		ReleaseNotes:  release.Body,
		HtmlURL:       release.HtmlURL,
	}, nil
}

// OpenReleasePage 在浏览器中打开 Release 页面
func (s *UpdaterService) OpenReleasePage(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		cmd = exec.Command("open", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	// 后台回收子进程，避免僵尸进程
	go func() { _ = cmd.Wait() }()
	return nil
}

// normalizeVersion 去除版本号前缀（v、V 等），返回纯数字版本号
func normalizeVersion(v string) string {
	for len(v) > 0 && (v[0] == 'v' || v[0] == 'V') {
		v = v[1:]
	}
	return v
}

// compareVersions 比较 semver 版本号 a 和 b
// 返回: 1 if a > b, -1 if a < b, 0 if a == b
func compareVersions(a, b string) int {
	var aMajor, aMinor, aPatch int
	var bMajor, bMinor, bPatch int
	fmt.Sscanf(a, "%d.%d.%d", &aMajor, &aMinor, &aPatch)
	fmt.Sscanf(b, "%d.%d.%d", &bMajor, &bMinor, &bPatch)
	if aMajor != bMajor {
		if aMajor > bMajor {
			return 1
		}
		return -1
	}
	if aMinor != bMinor {
		if aMinor > bMinor {
			return 1
		}
		return -1
	}
	if aPatch != bPatch {
		if aPatch > bPatch {
			return 1
		}
		return -1
	}
	return 0
}

// getManager 懒加载并复用 UpdateManager，避免每次 Check 都新建实例
// 导致已下载的更新包丢失和锁文件/句柄泄漏。
func (s *UpdaterService) getManager() (*velopack.UpdateManager, error) {
	if s.manager != nil {
		return s.manager, nil
	}
	// cgo 不可用时直接返回 nil（无更新），不报错
	if s.cgoUnavailable {
		return nil, nil
	}
	manager, err := velopack.NewUpdateManager(s.updateURL)
	if err != nil {
		// cgo disabled 或 velopack 初始化失败时，标记为不可用，静默处理
		s.cgoUnavailable = true
		return nil, nil
	}
	s.manager = manager
	return manager, nil
}

func (s *UpdaterService) CheckForUpdates() (*UpdateInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// 如果已经下载了更新，不要重复检查——防止丢失已下载内容
	if s.state == stateDownloaded && s.latest != nil {
		return &UpdateInfo{
			IsAvailable: true,
			Version:     s.latest.TargetFullRelease.Version,
		}, nil
	}

	manager, err := s.getManager()
	if err != nil || manager == nil {
		// cgo 不可用或 manager 初始化失败，返回无更新（不报错）
		return &UpdateInfo{IsAvailable: false}, nil
	}

	latest, status, err := manager.CheckForUpdates()
	if err != nil {
		return &UpdateInfo{IsAvailable: false}, nil
	}

	if status == velopack.UpdateAvailable && latest != nil && latest.TargetFullRelease != nil {
		s.latest = latest
		s.state = stateChecked
		return &UpdateInfo{
			IsAvailable: true,
			Version:     latest.TargetFullRelease.Version,
		}, nil
	}

	s.latest = nil
	s.state = stateIdle
	return &UpdateInfo{IsAvailable: false}, nil
}

func (s *UpdaterService) DownloadUpdate() error {
	s.mu.Lock()
	manager := s.manager
	latest := s.latest
	s.mu.Unlock()

	if manager == nil || latest == nil {
		return fmt.Errorf("no update pending")
	}

	err := manager.DownloadUpdates(latest, func(progress uint) {
		s.emitter.EmitProgress(progress)
	})
	if err != nil {
		return fmt.Errorf("failed to download update: %w", err)
	}

	s.mu.Lock()
	// 仅当 latest 未被并发 CheckForUpdates 修改时才标记为已下载
	if s.latest == latest {
		s.state = stateDownloaded
	}
	s.mu.Unlock()

	return nil
}

func (s *UpdaterService) ApplyAndRestart() error {
	s.mu.Lock()
	manager := s.manager
	latest := s.latest
	state := s.state
	s.mu.Unlock()

	if manager == nil || latest == nil {
		return fmt.Errorf("no update pending")
	}
	// 确保更新已下载完成，防止应用未下载的更新导致损坏
	if state != stateDownloaded {
		return fmt.Errorf("update not downloaded yet (current state: %d)", state)
	}

	return manager.ApplyUpdatesAndRestart(latest)
}
