package sync

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"strings"
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
	db           *sql.DB
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

	// lifecycleMu 串行化自动同步循环的启动/停止。
	// 启动需要先取消并等待旧循环退出，而等待期间不能持有 mutex（同步体自身
	// 也会获取它）；若只用 mutex，并发的 Start/Stop 会看到中间态（字段均为 nil），
	// 出现"Stop 已返回但新循环仍被启动"的情况。
	lifecycleMu sync.Mutex

	// lastLocalQueryAt 记录上一轮本地变更查询的发起的本地时刻。
	// 下一轮以「该时刻 - SyncMargin」作为本地侧下界：若改用「当前时间 - 轮询间隔」，
	// 单轮请求耗时或失败退避一旦超过轮询间隔，请求期间产生的本地修改就会落在
	// 下界之外，而游标已推进到请求之后，这些修改将永久无法被 GetBlobsSince 命中。
	// 仅在 Sync 内读写：isSyncing 保证同一时刻只有一个 Sync 在执行。
	lastLocalQueryAt time.Time

	// syncGate 保护「同步执行」与「整体替换本地数据」的互斥。
	// 同步持读锁，备份导入/数据擦除持写锁：前者保证替换期间没有同步在跑，
	// 后者保证替换时不会被在途同步读到半替换状态。
	syncGate sync.RWMutex
}

func NewSyncService(
	q *dbgen.Queries,
	db *sql.DB,
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
		db:           db,
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

// ResetSyncCursor 清除增量同步游标。
//
// 切换同步方式时必须调用：游标是由上一种方式写入的（服务器同步写入服务端
// 返回的 SyncTime，WebDAV 写入本地时间），换到另一种方式后作为冲突检测基准
// 会失真。服务器时钟领先本地时，本地修改不再被判定为"晚于基准"，冲突不会
// 被记录，落败的一方被静默覆盖且用户无法恢复。
//
// 与同步执行互斥，避免在途同步在清空后又把旧游标写回。
//
//wails:ignore 仅由后端装配调用，不暴露给前端
func (s *SyncService) ResetSyncCursor(ctx context.Context) error {
	s.syncGate.Lock()
	defer s.syncGate.Unlock()

	user, err := s.q.GetUser(ctx)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// 尚未创建账户，没有游标可清
			return nil
		}
		return err
	}
	return s.q.UpdateUserLastSyncTime(ctx, dbgen.UpdateUserLastSyncTimeParams{
		LastSyncTime: sql.NullString{},
		ID:           user.ID,
	})
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

	// 本地变更查询下界取「上次同步游标回退余量」与「上一轮查询时刻回退余量」的较小值。
	//
	// 游标写入的是服务器返回的 SyncTime，可能晚于本次本地查询时刻：一旦同步请求
	// 耗时（含超时重试）超过安全余量，请求期间产生的本地修改会小于下一轮的下界，
	// 从而被永久跳过、静默丢失。以本地时钟为准的下界必然早于本地查询时刻，
	// 可保证这些修改在下一轮仍被纳入；重复上传是幂等 upsert，无副作用。
	//
	// 以「当前时间 - 轮询间隔」为界并不充分：单轮请求耗时或失败退避都可能超过
	// 轮询间隔，此时请求期间产生的修改仍会落在下界之前，而游标已推进到请求之后，
	// 后续每一轮的下界都晚于它，该修改将永久无法被查询命中。因此记录上一轮真正
	// 发起查询的时刻，以它回退 SyncMargin 作为本地侧下界，使相邻两轮的查询窗口
	// 必然重叠，与轮询间隔、退避和请求耗时的变化无关。
	queryAt := time.Now()
	previousQueryAt := s.lastLocalQueryAt
	if previousQueryAt.IsZero() {
		// 进程首次同步没有上一轮查询时刻：以当前时刻为基准（等价于只回退
		// SyncMargin），实际范围由同步游标决定，避免退化为无意义的全量重扫
		// （游标为空时 SinceBound 本身已返回 epoch）。
		previousQueryAt = queryAt
	}
	s.lastLocalQueryAt = queryAt

	pushBound := timeutil.SinceBound(lastSyncString)
	if localBound := timeutil.Format(previousQueryAt.Add(-timeutil.SyncMargin)); localBound < pushBound {
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
			// 服务端返回的条目缺少 ID 或时间戳时直接跳过：ID 为空会写入一条
			// 无法被任何查询命中的脏数据，零值时间戳会被格式化成公元 1 年，
			// 既可能污染冲突记录，也会让后续增量查询反复命中该条目。
			if strings.TrimSpace(incoming.ID) == "" || time.Time(incoming.UpdatedAt).IsZero() {
				continue
			}
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

	// 服务端未返回有效的 SyncTime（字段缺失/解析为零值）时保持游标不变。
	// 若照常写入零值，游标会退化到公元 1 年，下一轮变成全量同步并反复重扫，
	// 同时冲突检测基准失真：所有远端变更都会被当成"比本地新"。
	if syncTime := time.Time(res.SyncTime); !syncTime.IsZero() {
		newSyncTimeStr := timeutil.Format(syncTime)
		err = s.q.UpdateUserLastSyncTime(ctx, dbgen.UpdateUserLastSyncTimeParams{
			LastSyncTime: sql.NullString{String: newSyncTimeStr, Valid: true},
			ID:           user.ID,
		})
		if err != nil {
			return err
		}
	}

	s.emitter.EmitStatus(SyncStatusSuccess)

	return nil
}
