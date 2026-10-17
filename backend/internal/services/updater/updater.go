package updater

import (
	"errors"
	"fmt"
	neturl "net/url"
	"os/exec"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"

	"github.com/quaadgras/velopack-go/velopack"
)

// ErrDownloadInProgress 表示已有一个下载任务在进行中。
// 并发调用返回该错误而非重复下载，避免同一更新包被下载多次、
// 以及调用方在下载未完成时误以为已就绪。
var ErrDownloadInProgress = errors.New("update download already in progress")

type Emitter interface {
	EmitProgress(percent uint)
}

type UpdateInfo struct {
	IsAvailable bool   `json:"isAvailable"`
	Version     string `json:"version"`
}

// GitHubReleaseInfo GitHub Release 信息
type GitHubReleaseInfo struct {
	HasUpdate      bool   `json:"hasUpdate"`
	LatestVersion  string `json:"latestVersion"`
	CurrentVersion string `json:"currentVersion"`
	PublishedAt    string `json:"publishedAt"`
	ReleaseNotes   string `json:"releaseNotes"`
	HtmlURL        string `json:"htmlUrl"`
	// Assets 发布资产，供前端展示可下载的安装包及其校验和文件
	Assets []ReleaseAsset `json:"assets"`
}

// updaterState 更新器内部状态机
type updaterState int

const (
	stateIdle       updaterState = iota // 空闲，未检查
	stateChecked                        // 已检查，有待下载更新
	stateDownloaded                     // 已下载，待应用
)

type UpdaterService struct {
	updateURL  string
	githubRepo string
	emitter    Emitter
	manager    *velopack.UpdateManager
	latest     *velopack.UpdateInfo
	state      updaterState
	mu         sync.Mutex
	// downloading 标记是否有下载任务在进行中，防止并发重复下载
	downloading bool
	// manualDownloading 标记手动「下载并校验」是否在进行中，
	// 与 velopack 的 downloading 分开，避免两条下载路径互相干扰
	manualDownloading bool
	// verifiedPath 最近一次通过 SHA256 校验的安装包路径
	verifiedPath string
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
		// 构建注入的是 git tag（形如 v0.6.0），统一去掉 v 前缀，
		// 避免界面出现「当前版本 v0.6.0 / 最新版本 0.6.0」的不一致展示。
		return normalizeVersion(Version)
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

	release, err := s.fetchLatestRelease()
	if err != nil {
		return nil, err
	}

	latestVersion := normalizeVersion(release.TagName)
	// 开发构建（"dev"）无法判断版本，默认提示有更新
	hasUpdate := currentVersion == "dev" || compareVersions(latestVersion, normalizeVersion(currentVersion)) > 0

	return &GitHubReleaseInfo{
		HasUpdate:      hasUpdate,
		LatestVersion:  latestVersion,
		CurrentVersion: currentVersion,
		PublishedAt:    release.PublishedAt,
		ReleaseNotes:   release.Body,
		HtmlURL:        release.HtmlURL,
		Assets:         release.Assets,
	}, nil
}

// OpenReleasePage 在浏览器中打开 Release 页面。
//
// url 来自前端，交给系统协议处理器前必须校验：Windows 的
// rundll32 url.dll,FileProtocolHandler 会打开 file:// 甚至直接执行本地可执行
// 文件，若不校验 scheme/host，受损的渲染进程即可借此启动任意本地程序或协议。
// 这里仅允许 http(s) 且限定 GitHub 主机，堵住这条通用启动通道。
func (s *UpdaterService) OpenReleasePage(url string) error {
	u, err := neturl.Parse(url)
	if err != nil {
		return fmt.Errorf("非法的 Release 链接: %w", err)
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return fmt.Errorf("拒绝打开非 http(s) 链接: %q", u.Scheme)
	}
	host := strings.ToLower(u.Hostname())
	if host != "github.com" && !strings.HasSuffix(host, ".github.com") {
		return fmt.Errorf("拒绝打开非 GitHub 链接: %q", host)
	}

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
	aMajor, aMinor, aPatch, aOK := parseSemverParts(a)
	bMajor, bMinor, bPatch, bOK := parseSemverParts(b)
	if !aOK || !bOK {
		// 任一侧不是形如 X.Y.Z 的纯数字版本（如 release-2024）时，逐段比较会把
		// 两侧都读成 0 而误判为"相等/无更新"。退化为字符串比较，至少不会漏报。
		return strings.Compare(a, b)
	}
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

// parseSemverParts 解析形如 X.Y.Z 的版本号，要求三段均为整数。
// 解析失败时 ok 为 false，避免把无法识别的标签静默当作 0.0.0。
func parseSemverParts(v string) (major, minor, patch int, ok bool) {
	n, err := fmt.Sscanf(strings.TrimSpace(v), "%d.%d.%d", &major, &minor, &patch)
	if err != nil || n < 3 {
		return 0, 0, 0, false
	}
	return major, minor, patch, true
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

	// 下载进行中不得重新检查：velopack 的 manager 不支持并发调用；
	// 且重新检查会覆盖 s.latest，使下载完成后无法标记为已下载
	// （DownloadUpdate 会因 s.latest != latest 跳过状态更新），用户将无法应用更新
	if s.downloading {
		if s.latest != nil && s.latest.TargetFullRelease != nil {
			return &UpdateInfo{
				IsAvailable: true,
				Version:     s.latest.TargetFullRelease.Version,
			}, nil
		}
		return &UpdateInfo{IsAvailable: false}, nil
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
	// 并发调用只允许一个下载进行，其余立即返回错误：
	// 避免重复下载，也避免调用方在下载未完成时误判为已就绪
	if s.downloading {
		s.mu.Unlock()
		return ErrDownloadInProgress
	}

	manager := s.manager
	latest := s.latest
	if manager == nil || latest == nil {
		s.mu.Unlock()
		return fmt.Errorf("no update pending")
	}
	// 已下载完成则跳过，避免重复下载
	if s.state == stateDownloaded {
		s.mu.Unlock()
		return nil
	}

	s.downloading = true
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.downloading = false
		s.mu.Unlock()
	}()

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
