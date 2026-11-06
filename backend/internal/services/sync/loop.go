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

// maxBackoff 指数退避最大间隔
const maxBackoff = 5 * time.Minute

func (s *SyncService) StartAutoSync() {
	// 与 StopAutoSync 串行：两者都要操作同一组生命周期字段，且启动过程包含
	// 「等待旧循环退出」的阻塞窗口，期间字段处于中间态。
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()

	// 先取走旧循环的取消函数与完成通道，再在锁外等待其退出：
	// 旧循环可能正卡在一次 Sync 中，若只取消就覆盖 syncDone，旧 goroutine
	// 会在新配置下继续写游标/推送旧数据，且之后再也无法被 StopAutoSync 等到。
	s.mutex.Lock()
	oldCancel := s.cancelSync
	oldDone := s.syncDone
	s.cancelSync = nil
	s.syncDone = nil
	s.mutex.Unlock()

	if oldCancel != nil {
		oldCancel()
	}
	if oldDone != nil {
		<-oldDone
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})

	s.mutex.Lock()
	s.cancelSync = cancel
	s.syncDone = done
	s.mutex.Unlock()

	go func() {
		// 退出时关闭 done，令 StopAutoSync 能等到在途同步真正结束
		defer close(done)
		// 指数退避：连续失败时增大间隔，成功后重置
		backoff := s.currentInterval()
		consecutiveFailures := 0

		sync := func() {
			// 每次同步独立 recover，防止单次 panic 永久杀死同步循环
			defer func() {
				if r := recover(); r != nil {
					slog.Error("sync panic recovered", "panic", r, "stack", string(debug.Stack()))
					s.emitter.EmitStatus(SyncStatusError)
					consecutiveFailures++
					baseInterval := s.currentInterval()
					backoff = time.Duration(float64(baseInterval) * float64(int(1)<<min(consecutiveFailures, 6)))
					if backoff > maxBackoff {
						backoff = maxBackoff
					}
				}
			}()

			err := s.Sync(ctx)
			if err != nil {
				if !errors.Is(err, context.Canceled) {
					// ErrUnauthenticated 不记录错误日志、不发射 SyncError（已发射 Unauthenticated 状态）
					// 但仍触发退避，避免高频重试触发服务器速率限制
					if !errors.Is(err, ErrUnauthenticated) {
						slog.Error("background sync failed", "error", err, "consecutive_failures", consecutiveFailures+1)
						s.emitter.EmitSyncError(err)
					}
					consecutiveFailures++
					// 指数退避：每次失败翻倍间隔，上限 maxBackoff
					// 使用当前实际间隔作为基准（可能因同步方式切换而变化）
					baseInterval := s.currentInterval()
					backoff = time.Duration(float64(baseInterval) * float64(int(1)<<min(consecutiveFailures, 6)))
					if backoff > maxBackoff {
						backoff = maxBackoff
					}
				}
			} else {
				// 成功后重置退避
				consecutiveFailures = 0
				backoff = s.currentInterval()
			}
		}

		sync()

		for {
			// 动态使用退避间隔
			ticker := time.NewTicker(backoff)
			select {
			case <-ctx.Done():
				ticker.Stop()
				return
			case <-ticker.C:
				ticker.Stop()
				sync()
			}
		}
	}()
}

// currentInterval 根据当前同步方式返回轮询间隔
func (s *SyncService) currentInterval() time.Duration {
	if s.isWebDAVSync() {
		return webdavSyncInterval
	}
	return s.syncInterval
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
	// 与 StartAutoSync 串行，避免在启动的等待窗口中看到中间态而提前返回
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()

	s.mutex.Lock()
	cancel := s.cancelSync
	done := s.syncDone
	s.cancelSync = nil
	s.syncDone = nil
	s.mutex.Unlock()

	if cancel != nil {
		cancel()
	}
	// 等待在途同步 goroutine 真正退出后再返回。
	// 否则它可能在调用方（如「断开云」）清空 ServerUrl/LastSyncTime 之后
	// 写回 LastSyncTime，或继续向旧服务器推送数据，覆盖刚完成的断开状态。
	// 注意必须在 s.mutex 之外等待：同步体自身也要获取 s.mutex。
	if done != nil {
		<-done
	}
}
