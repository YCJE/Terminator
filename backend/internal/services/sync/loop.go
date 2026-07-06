package sync

import (
	"context"
	"errors"
	"log/slog"
	"runtime/debug"
	"time"
)

// webdavSyncInterval WebDAV 全量同步的轮询间隔（全量传输，间隔较长）
const webdavSyncInterval = 60 * time.Second

func (s *SyncService) StartAutoSync() {
	s.mutex.Lock()
	if s.cancelSync != nil {
		s.cancelSync()
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancelSync = cancel
	s.mutex.Unlock()

	// 根据同步方式选择轮询间隔：WebDAV 全量传输用较长间隔，服务器同步用较短间隔
	interval := s.syncInterval
	if s.isWebDAVSync() {
		interval = webdavSyncInterval
	}

	go func() {
		defer func() {
			if r := recover(); r != nil {
				slog.Error("sync goroutine panic", "panic", r, "stack", string(debug.Stack()))
				s.emitter.EmitStatus(SyncStatusError)
			}
		}()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		sync := func() {
			err := s.Sync(ctx)
			if err != nil {
				if !errors.Is(err, context.Canceled) {
					slog.Error("background sync failed", "error", err)
					s.emitter.EmitSyncError(err)
					// SyncStatusError 已由 Sync() 的 defer 统一发射，此处不再重复
				}
			}
		}

		sync()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				sync()
			}
		}
	}()
}

// isWebDAVSync 判断当前是否使用 WebDAV 同步方式
func (s *SyncService) isWebDAVSync() bool {
	if s.settingsSvc == nil {
		return false
	}
	appSettings, err := s.settingsSvc.GetSettings()
	if err != nil {
		return false
	}
	return appSettings.SyncMethod == "webdav"
}

func (s *SyncService) StopAutoSync() {
	s.mutex.Lock()
	defer s.mutex.Unlock()
	if s.cancelSync != nil {
		s.cancelSync()
		s.cancelSync = nil
	}
}
