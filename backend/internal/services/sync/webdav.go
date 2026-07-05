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

// webdavBlob 是 WebDAV 同步数据包中单个 blob 的结构
type webdavBlob struct {
	ID        string `json:"id"`
	Blob      string `json:"blob"`         // base64 密文
	UpdatedAt string `json:"updated_at"`   // RFC3339Nano
	IsDeleted bool   `json:"is_deleted"`
}

// webdavSyncData 是加密前打包的整体结构
type webdavSyncData struct {
	Blobs    []webdavBlob `json:"blobs"`
	SyncTime string       `json:"sync_time"` // RFC3339Nano
}

// syncWebDAV 执行 WebDAV 全量同步
//
// 流程：
//  1. 从 DB 读取所有 blob，打包成 JSON
//  2. 用 MasterKey 加密
//  3. GET 远端文件 syncdata.enc，拿到远端 ETag 和密文
//  4. 如果远端有文件：解密 → 按 blob ID 逐条比对 updatedAt，取较新的（last-write-wins）
//  5. 合并后的结果写回本地 DB（UpsertBlob），重新加密上传
//  6. 上传时用 If-Match ETag 防止覆盖冲突；如果 412，报错让下次重试
func (s *SyncService) syncWebDAV(ctx context.Context, cfg WebDAVConfig) error {
	// 获取 MasterKey 用于加解密
	masterKey, err := s.vault.GetMasterKey()
	if err != nil {
		return err
	}

	// 构造远端同步文件的完整 URL
	syncFileURL, err := buildSyncFileURL(cfg.URL)
	if err != nil {
		return fmt.Errorf("构造 WebDAV 同步文件 URL 失败: %w", err)
	}

	// 1. 读取本地所有 blob（包括已删除的墓碑记录，用于全量同步）
	localBlobs, err := s.loadAllLocalBlobs(ctx)
	if err != nil {
		return fmt.Errorf("读取本地 blob 失败: %w", err)
	}

	// 2. GET 远端文件
	remoteCiphertext, remoteETag, err := webdav.GetFile(syncFileURL, cfg.Username, cfg.Password)
	if err != nil {
		return fmt.Errorf("获取远端同步文件失败: %w", err)
	}

	// 3. 解析远端数据（若存在）
	remoteBlobs := map[string]webdavBlob{}
	if len(remoteCiphertext) > 0 {
		// 远端文件内容是 base64 密文字符串，解密得到明文 JSON
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

	// 4. 合并：本地为基准，远端较新者覆盖；记录需要写回本地 DB 的条目
	merged := make(map[string]webdavBlob, len(localBlobs)+len(remoteBlobs))
	localDBWrites := make([]dbgen.UpsertBlobParams, 0)

	// 先放入所有本地 blob
	for id, lb := range localBlobs {
		merged[id] = webdavBlob{
			ID:        lb.ID,
			Blob:      lb.Blob,
			UpdatedAt: lb.UpdatedAt,
			IsDeleted: lb.IsDeleted,
		}
	}

	// 用远端数据合并：远端较新或本地缺失的，采用远端并写回本地 DB
	for id, rb := range remoteBlobs {
		existing, ok := merged[id]
		if !ok {
			// 本地没有，直接采用远端
			merged[id] = rb
			localDBWrites = append(localDBWrites, dbgen.UpsertBlobParams{
				ID:        rb.ID,
				Blob:      rb.Blob,
				UpdatedAt: rb.UpdatedAt,
				IsDeleted: rb.IsDeleted,
			})
			continue
		}

		// 本地和远端都有，按 updatedAt 比较（last-write-wins）
		localTime, err := parseTime(existing.UpdatedAt)
		if err != nil {
			return fmt.Errorf("解析本地 blob 时间失败 (id=%s): %w", id, err)
		}
		remoteTime, err := parseTime(rb.UpdatedAt)
		if err != nil {
			return fmt.Errorf("解析远端 blob 时间失败 (id=%s): %w", id, err)
		}

		if remoteTime.After(localTime) {
			// 远端较新，采用远端并写回本地 DB
			merged[id] = rb
			localDBWrites = append(localDBWrites, dbgen.UpsertBlobParams{
				ID:        rb.ID,
				Blob:      rb.Blob,
				UpdatedAt: rb.UpdatedAt,
				IsDeleted: rb.IsDeleted,
			})
		}
		// 否则保留本地（已存在于 merged 中）
	}

	// 5. 将远端较新的条目写回本地 DB
	hasRemoteUpdates := len(localDBWrites) > 0
	for _, p := range localDBWrites {
		if err = s.q.UpsertBlob(ctx, p); err != nil {
			return fmt.Errorf("写回本地 blob 失败 (id=%s): %w", p.ID, err)
		}
	}

	// 6. 打包合并后的数据并加密上传
	syncData := webdavSyncData{
		Blobs:    make([]webdavBlob, 0, len(merged)),
		SyncTime: time.Now().UTC().Format(time.RFC3339Nano),
	}
	for _, b := range merged {
		syncData.Blobs = append(syncData.Blobs, b)
	}

	jsonBytes, err := json.Marshal(syncData)
	if err != nil {
		return fmt.Errorf("序列化同步数据失败: %w", err)
	}

	// 加密得到 base64 密文字符串，作为文件内容上传
	packedBase64, err := crypto.EncryptAndPack(jsonBytes, masterKey)
	if err != nil {
		return fmt.Errorf("加密同步数据失败: %w", err)
	}

	// 上传，使用 If-Match 远端 ETag 防止覆盖冲突
	_, err = webdav.PutFile(syncFileURL, cfg.Username, cfg.Password, []byte(packedBase64), remoteETag)
	if err != nil {
		// 412 Precondition Failed：远端在我们 GET 之后被其他端修改了，报错让下次重试
		var pfErr *webdav.PreconditionFailedError
		if errors.As(err, &pfErr) {
			return fmt.Errorf("WebDAV 同步冲突，远端文件已被修改，将下次重试: %w", err)
		}
		return fmt.Errorf("上传同步数据失败: %w", err)
	}

	// 更新本地最后同步时间
	nowStr := time.Now().UTC().Format(time.RFC3339Nano)
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

	// 如果远端带来了更新，通知前端
	if hasRemoteUpdates {
		s.emitter.EmitUpdatesAvailable()
	}

	s.emitter.EmitStatus(SyncStatusSuccess)
	return nil
}

// loadAllLocalBlobs 读取本地所有 blob（包括已删除的），按 ID 去重合并。
// 同时使用 GetActiveBlobs（所有未删除）和 GetBlobsSince(epoch)（所有变更，含墓碑），
// 取并集确保拿到完整状态。
func (s *SyncService) loadAllLocalBlobs(ctx context.Context) (map[string]dbgen.EncryptedBlob, error) {
	result := make(map[string]dbgen.EncryptedBlob)

	// 读取所有未删除的 blob
	activeBlobs, err := s.q.GetActiveBlobs(ctx)
	if err != nil {
		return nil, err
	}
	for _, b := range activeBlobs {
		result[b.ID] = b
	}

	// 读取所有变更（自 epoch 起，即全部，包含已删除的墓碑记录）
	epoch := time.Unix(0, 0).UTC().Format(time.RFC3339Nano)
	allBlobs, err := s.q.GetBlobsSince(ctx, epoch)
	if err != nil {
		return nil, err
	}
	for _, b := range allBlobs {
		// 以较新的为准（GetBlobsSince 可能包含与 GetActiveBlobs 相同的条目）
		if existing, ok := result[b.ID]; ok {
			existingTime, err1 := parseTime(existing.UpdatedAt)
			newTime, err2 := parseTime(b.UpdatedAt)
			if err1 == nil && err2 == nil && newTime.After(existingTime) {
				result[b.ID] = b
			}
		} else {
			result[b.ID] = b
		}
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

// parseTime 解析 RFC3339Nano 时间字符串
func parseTime(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t, err = time.Parse(time.RFC3339, s)
	}
	return t, err
}
