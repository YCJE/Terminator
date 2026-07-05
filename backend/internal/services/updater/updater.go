package updater

import (
	"fmt"
	"sync"

	"github.com/quaadgras/velopack-go/velopack"
)

type Emitter interface {
	EmitProgress(percent uint)
}

type UpdateInfo struct {
	IsAvailable bool   `json:"isAvailable"`
	Version     string `json:"version"`
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
	emitter   Emitter
	manager   *velopack.UpdateManager
	latest    *velopack.UpdateInfo
	state     updaterState
	mu        sync.Mutex
}

func NewUpdaterService(updateURL string, emitter Emitter) *UpdaterService {
	return &UpdaterService{
		updateURL: updateURL,
		emitter:   emitter,
		state:     stateIdle,
	}
}

// getManager 懒加载并复用 UpdateManager，避免每次 Check 都新建实例
// 导致已下载的更新包丢失和锁文件/句柄泄漏。
func (s *UpdaterService) getManager() (*velopack.UpdateManager, error) {
	if s.manager != nil {
		return s.manager, nil
	}
	manager, err := velopack.NewUpdateManager(s.updateURL)
	if err != nil {
		return nil, fmt.Errorf("failed to create update manager: %w", err)
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
	if err != nil {
		return nil, err
	}

	latest, status, err := manager.CheckForUpdates()
	if err != nil {
		return nil, fmt.Errorf("failed to check for updates: %w", err)
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
	s.state = stateDownloaded
	s.mu.Unlock()

	return nil
}

func (s *UpdaterService) ApplyAndRestart() error {
	s.mu.Lock()
	manager := s.manager
	latest := s.latest
	s.mu.Unlock()

	if manager == nil || latest == nil {
		return fmt.Errorf("no update pending")
	}

	return manager.ApplyUpdatesAndRestart(latest)
}
