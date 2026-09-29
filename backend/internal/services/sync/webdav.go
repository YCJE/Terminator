package sync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"time"

	"terminator-desktop/backend/internal/crypto"
	"terminator-desktop/backend/internal/dbgen"
	"terminator-desktop/backend/internal/timeutil"
	"terminator-desktop/backend/internal/webdav"
)

// WebDAVConfig WebDAV 同步配置
type WebDAVConfig struct {
	URL      string
	Username string
	Password string
}

// syncFileName WebDAV 上存放同步数据的文件名
const syncFileName = "syncdata.enc"

// maxSyncFileSize 同步文件最大允许大小（10MB），防止恶意服务器返回超大响应导致 OOM
const maxSyncFileSize = 10 * 1024 * 1024

// webdavBlob 是 WebDAV 同步数据包中单个 blob 的结构
type webdavBlob struct {
	ID        string `json:"id"`
	Blob      string `json:"blob"`       // base64 密文
	UpdatedAt string `json:"updated_at"` // RFC3339Nano
	IsDeleted bool   `json:"is_deleted"`
}

// webdavSyncData 是加密前打包的整体结构
type webdavSyncData struct {
	Blobs    []webdavBlob `json:"blobs"`
	SyncTime string       `json:"sync_time"` // RFC3339Nano
}

// syncWebDAV 执行 WebDAV 全量同步
func (s *SyncService) syncWebDAV(ctx context.Context, cfg WebDAVConfig) error {
	masterKey, err := s.vault.GetMasterKey()
	if err != nil {
		return err
	}
	defer func() {
		for i := range masterKey {
			masterKey[i] = 0
		}
	}()

	syncFileURL, err := buildSyncFileURL(cfg.URL)
	if err != nil {
		return fmt.Errorf("构造 WebDAV 同步文件 URL 失败: %w", err)
	}

	// 1. 读取本地所有 blob（包括已删除的墓碑记录）
	localBlobs, err := s.loadAllLocalBlobs(ctx)
	if err != nil {
		return fmt.Errorf("读取本地 blob 失败: %w", err)
	}

	// 2. GET 远端文件
	remoteCiphertext, remoteETag, err := webdav.GetFile(ctx, syncFileURL, cfg.Username, cfg.Password)
	if err != nil {
		return fmt.Errorf("获取远端同步文件失败: %w", err)
	}

	// 3. 解析远端数据（若存在）
	remoteBlobs := map[string]webdavBlob{}
	if len(remoteCiphertext) > 0 {
		plainJSON, err := crypto.UnpackAndDecrypt(string(remoteCiphertext), masterKey)
		if err != nil {
			return fmt.Errorf("解密远端同步数据失败: %w", err)
		}

		var remoteData webdavSyncData
		if err = json.Unmarshal(plainJSON, &remoteData); err != nil {
			return fmt.Errorf("解析远端同步数据失败: %w", err)
		}

		for _, rb := range remoteData.Blobs {
			remoteBlobs[rb.ID] = rb
		}
	}

	// 4. 合并：本地为基准，远端较新者覆盖
	merged := make(map[string]webdavBlob, len(localBlobs)+len(remoteBlobs))
	localDBWrites := make([]dbgen.UpsertBlobParams, 0)

	for id, lb := range localBlobs {
		merged[id] = webdavBlob{
			ID:        lb.ID,
			Blob:      lb.Blob,
			UpdatedAt: lb.UpdatedAt,
			IsDeleted: lb.IsDeleted,
		}
	}

	for id, rb := range remoteBlobs {
		existing, ok := merged[id]
		if !ok {
			merged[id] = rb
			localDBWrites = append(localDBWrites, dbgen.UpsertBlobParams{
				ID:        rb.ID,
				Blob:      rb.Blob,
				UpdatedAt: rb.UpdatedAt,
				IsDeleted: rb.IsDeleted,
			})
			continue
		}

		if remoteWins(existing, rb) {
			merged[id] = rb
			localDBWrites = append(localDBWrites, dbgen.UpsertBlobParams{
				ID:        rb.ID,
				Blob:      rb.Blob,
				UpdatedAt: rb.UpdatedAt,
				IsDeleted: rb.IsDeleted,
			})
		}
	}

	// 5. 将远端较新的条目写回本地 DB
	hasRemoteUpdates := len(localDBWrites) > 0
	for _, p := range localDBWrites {
		if err = s.q.UpsertBlob(ctx, p); err != nil {
			return fmt.Errorf("写回本地 blob 失败 (id=%s): %w", p.ID, err)
		}
	}

	// 6. 检查本地是否有比远端更新的数据（含删除操作）
	//    不能仅比较数量，因为软删除不改变数量
	hasLocalUpdates := false
	localMap := make(map[string]dbgen.EncryptedBlob, len(localBlobs))
	for _, lb := range localBlobs {
		localMap[lb.ID] = lb
	}
	for _, rb := range remoteBlobs {
		lb, exists := localMap[rb.ID]
		if !exists {
			// 远端有本地不存在的条目（hasRemoteUpdates 已在此场景为 true，
			// 此处冗余标记不影响逻辑，但保留以防上游逻辑变化）
			hasLocalUpdates = true
			break
		}
		if !sameTimestamp(lb.UpdatedAt, rb.UpdatedAt) || lb.IsDeleted != rb.IsDeleted {
			hasLocalUpdates = true // 本地有更新或删除
			break
		}
	}
	if len(localBlobs) != len(remoteBlobs) {
		hasLocalUpdates = true // 数量不同，一定有变更
	}

	// 如果本地和远端数据完全一致（无变更），跳过上传
	if !hasRemoteUpdates && !hasLocalUpdates {
		s.emitter.EmitStatus(SyncStatusSuccess)
		return nil
	}

	// 7. 打包合并后的数据并加密上传
	syncData := webdavSyncData{
		Blobs:    make([]webdavBlob, 0, len(merged)),
		SyncTime: timeutil.Now(),
	}
	for _, b := range merged {
		syncData.Blobs = append(syncData.Blobs, b)
	}

	jsonBytes, err := json.Marshal(syncData)
	if err != nil {
		return fmt.Errorf("序列化同步数据失败: %w", err)
	}

	packedBase64, err := crypto.EncryptAndPack(jsonBytes, masterKey)
	if err != nil {
		return fmt.Errorf("加密同步数据失败: %w", err)
	}

	_, err = webdav.PutFile(ctx, syncFileURL, cfg.Username, cfg.Password, []byte(packedBase64), remoteETag)
	if err != nil {
		var pfErr *webdav.PreconditionFailedError
		if errors.As(err, &pfErr) {
			return fmt.Errorf("WebDAV 同步冲突，远端文件已被修改，将下次重试: %w", err)
		}
		return fmt.Errorf("上传同步数据失败: %w", err)
	}

	// 更新本地最后同步时间
	nowStr := timeutil.Now()
	user, err := s.q.GetUser(ctx)
	if err != nil {
		return fmt.Errorf("读取用户信息失败: %w", err)
	}
	if err = s.q.UpdateUserLastSyncTime(ctx, dbgen.UpdateUserLastSyncTimeParams{
		LastSyncTime: sql.NullString{String: nowStr, Valid: true},
		ID:           user.ID,
	}); err != nil {
		return fmt.Errorf("更新最后同步时间失败: %w", err)
	}

	if hasRemoteUpdates {
		s.emitter.EmitUpdatesAvailable()
	}

	s.emitter.EmitStatus(SyncStatusSuccess)
	return nil
}

// loadAllLocalBlobs 读取本地所有 blob（包括已删除的墓碑记录），按 ID 去重。
// GetBlobsSince(epoch) 已返回全部记录（含已删除），无需再调 GetActiveBlobs。
func (s *SyncService) loadAllLocalBlobs(ctx context.Context) (map[string]dbgen.EncryptedBlob, error) {
	result := make(map[string]dbgen.EncryptedBlob)

	epoch := timeutil.Epoch()
	allBlobs, err := s.q.GetBlobsSince(ctx, epoch)
	if err != nil {
		return nil, err
	}
	for _, b := range allBlobs {
		result[b.ID] = b
	}

	return result, nil
}

// buildSyncFileURL 将 WebDAV 基础 URL 和同步文件名拼接成完整 URL
func buildSyncFileURL(baseURL string) (string, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	u = u.JoinPath(syncFileName)
	return u.String(), nil
}

// remoteWins 判断 WebDAV 冲突合并时远端条目是否应覆盖本地条目。
//
// 仅当远端严格更新时覆盖；时间戳相同时保留本地（本地为基准），
// 避免多端在同一时刻写入导致反复互相覆盖。
// 时间戳解析失败时退化为零值，使可解析的一方胜出，不中断整轮同步。
func remoteWins(local, remote webdavBlob) bool {
	return parseTimeOrZero(remote.UpdatedAt).After(parseTimeOrZero(local.UpdatedAt))
}

// parseTimeOrZero 解析 RFC3339 时间字符串，失败时返回零值。
// 单条脏数据不应中断整轮同步，退化为零值后由较新的一方胜出。
func parseTimeOrZero(s string) time.Time {
	t, err := timeutil.Parse(s)
	if err != nil {
		return time.Time{}
	}
	return t
}

// sameTimestamp 按时间值比较两个时间戳字符串，兼容旧版可变宽度格式与当前定长格式。
// 二者表示同一时刻但字符串不同时（如 ".5Z" 与 ".500000000Z"）视为相同，
// 避免无变更时的冗余上传；任一无法解析时退化为字符串比较。
func sameTimestamp(a, b string) bool {
	ta, errA := timeutil.Parse(a)
	tb, errB := timeutil.Parse(b)
	if errA != nil || errB != nil {
		return a == b
	}
	return ta.Equal(tb)
}
