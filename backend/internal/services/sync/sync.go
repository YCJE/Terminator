package sync

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"sync"
	"terminator-desktop/backend/internal/api"
	"terminator-desktop/backend/internal/dbgen"
	"terminator-desktop/backend/internal/services/settings"
	"terminator-desktop/backend/internal/timeutil"
	"terminator-desktop/backend/internal/vault"
	"time"
)

type SyncStatus string

const (
	SyncStatusIdle            = SyncStatus("idle")
	SyncStatusSyncing         = SyncStatus("syncing")
	SyncStatusSuccess         = SyncStatus("success")
	SyncStatusError           = SyncStatus("error")
	SyncStatusUnauthenticated = SyncStatus("unauthenticated")
)

// ErrUnauthenticated 表示同步因 401 认证失败而中止。
// 自动同步循环应为此错误应用退避策略，避免高频重试触发服务器速率限制。
var ErrUnauthenticated = errors.New("unauthenticated")

type SyncEmitter interface {
	EmitStatus(status SyncStatus)
	EmitUpdatesAvailable()
	EmitSyncError(err error)
}

type SyncService struct {
	q            *dbgen.Queries
	client       *api.Client
	vault        *vault.Vault
	emitter      SyncEmitter
	syncInterval time.Duration
	settingsSvc  *settings.SettingsService

	mutex      sync.Mutex
	isSyncing  bool
	cancelSync context.CancelFunc
	// syncDone 在自动同步 goroutine 退出时被关闭，供 StopAutoSync 等待在途同步结束
	syncDone chan struct{}

	// syncGate 保护「同步执行」与「整体替换本地数据」的互斥。
	// 同步持读锁，备份导入/数据擦除持写锁：前者保证替换期间没有同步在跑，
	// 后者保证替换时不会被在途同步读到半替换状态。
	syncGate sync.RWMutex
}

func NewSyncService(
	q *dbgen.Queries,
	client *api.Client,
	v *vault.Vault,
	emitter SyncEmitter,
	syncInterval *time.Duration,
	settingsSvc *settings.SettingsService) *SyncService {

	var interval time.Duration
	if syncInterval == nil {
		interval = time.Second * 3
	} else {
		interval = *syncInterval
	}
	// 非正间隔会让自动同步循环里的 time.NewTicker panic，而该 panic 发生在
	// recover 之外，会直接终止进程。此处兜底为默认值，保证间隔恒为正。
	if interval <= 0 {
		interval = time.Second * 3
	}

	return &SyncService{
		q:            q,
		client:       client,
		vault:        v,
		emitter:      emitter,
		syncInterval: interval,
		settingsSvc:  settingsSvc,
	}
}

func (s *SyncService) Authenticate(ctx context.Context) error {
	user, err := s.q.GetUser(ctx)
	if err != nil {
		return err
	}

	if !user.ServerUrl.Valid {
		return nil
	}
	serverUrl := user.ServerUrl.String

	loginKey, err := s.vault.GetLoginKey()
	if err != nil {
		return err
	}
	defer func() {
		for i := range loginKey {
			loginKey[i] = 0
		}
	}()

	loginKeyBase64 := base64.StdEncoding.EncodeToString(loginKey)

	res, err := s.client.Login(ctx, serverUrl, &api.LoginRequest{
		Username: user.Username,
		LoginKey: loginKeyBase64,
	})
	if err != nil {
		return err
	}

	s.client.SetToken(res.AccessToken)
	return nil
}

// PauseSync 暂停同步并等待在途同步结束，返回恢复函数（应 defer 调用）。
//
// 备份导入、数据擦除等会整体替换本地数据的操作必须先调用它，否则在途同步
// 可能读到替换前的旧副本并推送到服务器，把刚恢复/擦除的数据覆盖回去。
// 返回值是函数类型，绑定层无法序列化；若暴露给前端，前端拿到的是不可调用
// 的值、无法释放写锁，会导致同步永久挂死。
//
//wails:ignore 仅由后端装配调用，不暴露给前端
func (s *SyncService) PauseSync() func() {
	s.syncGate.Lock()
	return func() {
		s.syncGate.Unlock()
	}
}

func (s *SyncService) Sync(ctx context.Context) (err error) {
	// 等待整体替换数据的操作（备份导入 / 数据擦除）结束：在途同步读到的是
	// 替换前的旧副本，若继续执行会把旧数据推回服务器或写回本地。
	s.syncGate.RLock()
	defer s.syncGate.RUnlock()

	// 解锁状态必须在取得 syncGate 之后再检查：WipeData / LockVault 会先拿写锁，
	// 再清空 users 与内存密钥。若在加锁前检查，等锁期间数据可能已被擦除，
	// 之后 GetUser 得到 sql.ErrNoRows、GetLoginKey 得到 VaultLocked，会把用户
	// 刚完成的擦除或上锁误报成"同步失败"。
	if !s.vault.IsUnlocked() {
		return nil
	}

	s.mutex.Lock()
	if s.isSyncing {
		s.mutex.Unlock()
		return nil
	}
	s.isSyncing = true
	s.mutex.Unlock()

	defer func() {
		s.mutex.Lock()
		s.isSyncing = false
		s.mutex.Unlock()
	}()

	s.emitter.EmitStatus(SyncStatusSyncing)

	// 统一错误处理：任何错误路径都发射 SyncStatusError
	// ErrUnauthenticated 除外：已发射 SyncStatusUnauthenticated，不应被覆盖
	defer func() {
		if err != nil && !errors.Is(err, ErrUnauthenticated) {
			s.emitter.EmitStatus(SyncStatusError)
		}
	}()

	// 读取 AppSettings 判断同步方式：webdav 走 WebDAV 全量同步，其余走服务器同步
	if s.settingsSvc != nil {
		appSettings, err := s.settingsSvc.GetSettingsWithSecrets()
		if err != nil {
			return err
		}
		if appSettings.SyncMethod == "webdav" {
			return s.syncWebDAV(ctx, WebDAVConfig{
				URL:      appSettings.WebDAVURL,
				Username: appSettings.WebDAVUsername,
				Password: appSettings.WebDAVPassword,
			})
		}
	}

	user, err := s.q.GetUser(ctx)
	if err != nil {
		return err
	}

	if !user.ServerUrl.Valid {
		s.emitter.EmitStatus(SyncStatusIdle)
		return nil
	}
	serverUrl := user.ServerUrl.String

	if err = s.Authenticate(ctx); err != nil {
		// 401 特殊处理：清除 token 并发射未认证状态，与 s.client.Sync 的 401 处理保持一致
		var apiErr *api.APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode == 401 {
			s.client.ClearToken()
			s.emitter.EmitStatus(SyncStatusUnauthenticated)
			return ErrUnauthenticated // 返回 error 触发退避，避免高频重试
		}
		return err
	}

	lastSyncString := ""
	if user.LastSyncTime.Valid {
		lastSyncString = user.LastSyncTime.String
	}

	// 解析失败时退化为 epoch（全量同步），避免单条脏数据让同步永久失败
	lastSyncTime, parseErr := timeutil.Parse(lastSyncString)
	if parseErr != nil {
		lastSyncTime = time.Unix(0, 0).UTC()
	}

	// 本地变更查询下界取「上次同步游标回退余量」与「本地当前时间回退余量」的较小值。
	//
	// 游标写入的是服务器返回的 SyncTime，可能晚于本次本地查询时刻：一旦同步请求
	// 耗时（含超时重试）超过安全余量，请求期间产生的本地修改会小于下一轮的下界，
	// 从而被永久跳过、静默丢失。以本地时钟为准的下界必然早于本地查询时刻，
	// 可保证这些修改在下一轮仍被纳入；重复上传是幂等 upsert，无副作用。
	//
	// 以本地时钟为基准时必须再叠加一个轮询间隔：下界每轮随本地时间前移一个间隔，
	// 若只回退 SyncMargin（默认间隔 3s > 余量 2s），相邻两轮的查询窗口之间会出现
	// 缝隙，落进缝隙（例如服务器时钟领先时，下界恒为 now-2s）的本地修改将永久
	// 落在后续下界之外、再也无法被 GetBlobsSince 命中，导致静默丢失。
	pushBound := timeutil.SinceBound(lastSyncString)
	if localBound := timeutil.SinceBoundNowBy(s.syncInterval + timeutil.SyncMargin); localBound < pushBound {
		pushBound = localBound
	}

	localChanges, err := s.q.GetBlobsSince(ctx, pushBound)
	if err != nil {
		return err
	}

	// 本轮推送的本地副本，用于识别「两端各自修改同一项」的并发编辑
	pushedLocally := make(map[string]dbgen.EncryptedBlob, len(localChanges))
	for _, b := range localChanges {
		pushedLocally[b.ID] = b
	}

	apiBlobs := make([]api.EncryptedBlob, 0)
	for _, b := range localChanges {
		// 单条时间戳异常不应中断整轮同步：退化为 epoch 仍会正常上传该条
		parsedTime, parseErr := timeutil.Parse(b.UpdatedAt)
		if parseErr != nil {
			parsedTime = time.Unix(0, 0).UTC()
		}

		apiBlobs = append(apiBlobs, api.EncryptedBlob{
			ID:        b.ID,
			UpdatedAt: api.Timestamp(parsedTime),
			IsDeleted: b.IsDeleted,
			Blob:      b.Blob,
		})
	}

	req := &api.SyncRequest{
		Blobs:        apiBlobs,
		LastSyncTime: api.Timestamp(lastSyncTime),
	}

	res, err := s.client.Sync(ctx, serverUrl, req)
	if err != nil {
		var apiErr *api.APIError
		if errors.As(err, &apiErr) && apiErr.StatusCode == 401 {
			s.client.ClearToken()
			s.emitter.EmitStatus(SyncStatusUnauthenticated)
			// 返回 ErrUnauthenticated 触发退避，避免高频重试
			// defer 中检测到此 error 不会发射 SyncStatusError 覆盖 Unauthenticated 状态
			return ErrUnauthenticated
		}

		return err
	}

	if len(res.Blobs) > 0 {
		for _, incoming := range res.Blobs {
			updatedAtStr := timeutil.Format(time.Time(incoming.UpdatedAt))

			// 冲突检测：该 blob 本轮既被本地修改、又被服务端改动，且密文不同，
			// 说明两端各自编辑过同一项。服务端回显我们刚推送的副本时密文相同，
			// 不会误判。检测到冲突仍按「较新者生效」写入本地，避免本地停留在
			// 落败的旧值上反复产生冲突；双方副本已留存，用户可随时改选。
			if local, pushed := pushedLocally[incoming.ID]; pushed &&
				isConcurrentEdit(local.Blob, incoming.Blob, local.UpdatedAt, updatedAtStr, pushBound) {
				if err := s.recordConflict(ctx, dbgen.UpsertConflictParams{
					BlobID:          incoming.ID,
					LocalBlob:       local.Blob,
					RemoteBlob:      incoming.Blob,
					LocalUpdatedAt:  local.UpdatedAt,
					RemoteUpdatedAt: updatedAtStr,
					LocalDeleted:    local.IsDeleted,
					RemoteDeleted:   incoming.IsDeleted,
				}); err != nil {
					return err
				}
			}

			// 仅当服务端副本严格更新时才覆盖本地：本轮的本地修改会随请求一并上传，
			// 但服务端返回的可能是更旧的副本（例如来自另一台设备），无条件覆盖会把
			// 刚产生的本地编辑冲掉，且因时间戳回退到游标之前而再也不会被重新上传。
			err = s.q.UpsertBlobIfNewer(ctx, dbgen.UpsertBlobIfNewerParams{
				ID:        incoming.ID,
				Blob:      incoming.Blob,
				UpdatedAt: updatedAtStr,
				IsDeleted: incoming.IsDeleted,
			})
			if err != nil {
				return err
			}
		}
		s.emitter.EmitUpdatesAvailable()
	}

	newSyncTimeStr := timeutil.Format(time.Time(res.SyncTime))
	err = s.q.UpdateUserLastSyncTime(ctx, dbgen.UpdateUserLastSyncTimeParams{
		LastSyncTime: sql.NullString{String: newSyncTimeStr, Valid: true},
		ID:           user.ID,
	})
	if err != nil {
		return err
	}

	s.emitter.EmitStatus(SyncStatusSuccess)

	return nil
}
