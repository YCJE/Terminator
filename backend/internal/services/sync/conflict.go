package sync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	"terminator-desktop/backend/internal/apperror"
	"terminator-desktop/backend/internal/crypto"
	"terminator-desktop/backend/internal/dbgen"
	"terminator-desktop/backend/internal/timeutil"
)

// ConflictInfo 描述一条同步冲突，供前端展示与选择保留哪一端。
// 不含任何明文内容：名称与类型由后端在解锁状态下解密后给出。
type ConflictInfo struct {
	BlobID          string `json:"blobId"`
	ItemType        string `json:"itemType"` // host / key / snippet，解密失败时为空
	Name            string `json:"name"`     // 展示名，解密失败时为空
	LocalUpdatedAt  string `json:"localUpdatedAt"`
	RemoteUpdatedAt string `json:"remoteUpdatedAt"`
	LocalDeleted    bool   `json:"localDeleted"`
	RemoteDeleted   bool   `json:"remoteDeleted"`
	DetectedAt      string `json:"detectedAt"`
}

// isConcurrentEdit 判断同一 blob 的两端副本是否属于并发编辑。
//
// 密文相同说明两端内容一致（服务端回显我们刚推送的副本也属于这种情况），
// 不是冲突；只有两端都在 baseBound 之后各自改动过，才说明双方分别编辑了同一项，
// 此时无论哪一端胜出，另一端用户的修改都会被丢弃，需要让用户知情并选择。
func isConcurrentEdit(localCipher, remoteCipher, localAt, remoteAt, baseBound string) bool {
	if localCipher == remoteCipher {
		return false
	}
	return afterBound(localAt, baseBound) && afterBound(remoteAt, baseBound)
}

// afterBound 判断时间戳是否晚于增量同步下界。
// 解析失败时视为「已改动」：宁可多报一次冲突让用户确认，也不要静默丢弃修改。
func afterBound(t, bound string) bool {
	tt, err := timeutil.Parse(t)
	if err != nil {
		return true
	}
	bt, err := timeutil.Parse(bound)
	if err != nil {
		return true
	}
	return tt.After(bt)
}

// recordConflict 记录（或更新）一条冲突，保留双方副本。
// 同一 blob 只保留最近一次检测结果。
func (s *SyncService) recordConflict(ctx context.Context, arg dbgen.UpsertConflictParams) error {
	arg.DetectedAt = timeutil.Now()
	return s.q.UpsertConflict(ctx, arg)
}

// ListConflicts 返回全部未解决的同步冲突，按检测时间倒序。
func (s *SyncService) ListConflicts(ctx context.Context) ([]ConflictInfo, error) {
	rows, err := s.q.ListConflicts(ctx)
	if err != nil {
		return nil, err
	}

	infos := make([]ConflictInfo, 0, len(rows))
	for _, r := range rows {
		itemType, name := s.describeBlob(r.LocalBlob, r.RemoteBlob)
		infos = append(infos, ConflictInfo{
			BlobID:          r.BlobID,
			ItemType:        itemType,
			Name:            name,
			LocalUpdatedAt:  r.LocalUpdatedAt,
			RemoteUpdatedAt: r.RemoteUpdatedAt,
			LocalDeleted:    r.LocalDeleted,
			RemoteDeleted:   r.RemoteDeleted,
			DetectedAt:      r.DetectedAt,
		})
	}
	return infos, nil
}

// ConflictCount 返回未解决的冲突数量，供界面显示提示徽标。
func (s *SyncService) ConflictCount(ctx context.Context) (int, error) {
	n, err := s.q.CountConflicts(ctx)
	if err != nil {
		return 0, err
	}
	return int(n), nil
}

// ResolveConflict 按用户选择保留冲突中的一端：keepLocal 为 true 保留本地副本，
// 否则保留远端副本。
//
// 选中的副本以「当前时间」写回本地，因此它晚于本轮同步游标，会在下一轮同步中
// 上传并覆盖另一端；不这样做的话本地会一直停留在落败的旧值上反复产生冲突。
func (s *SyncService) ResolveConflict(ctx context.Context, blobID string, keepLocal bool) error {
	if !s.vault.IsUnlocked() {
		return apperror.VaultLocked()
	}

	conflict, err := s.q.GetConflict(ctx, blobID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return apperror.NotFound("conflict not found", err)
		}
		return err
	}

	chosen := dbgen.UpsertBlobParams{
		ID:        blobID,
		UpdatedAt: timeutil.Now(),
	}
	if keepLocal {
		chosen.Blob = conflict.LocalBlob
		chosen.IsDeleted = conflict.LocalDeleted
	} else {
		chosen.Blob = conflict.RemoteBlob
		chosen.IsDeleted = conflict.RemoteDeleted
	}

	if err := s.q.UpsertBlob(ctx, chosen); err != nil {
		return err
	}
	if err := s.q.DeleteConflict(ctx, blobID); err != nil {
		return err
	}

	// 条目内容已变化，通知界面刷新主机/密钥/片段列表
	s.emitter.EmitUpdatesAvailable()
	return nil
}

// describeBlob 从冲突双方的密文中提取条目类型与展示名。
// 优先取本地副本，解密失败时退回远端副本；两侧都无法解密时返回空值，
// 冲突本身仍然可见，只是缺少可读描述。
func (s *SyncService) describeBlob(localCipher, remoteCipher string) (string, string) {
	if itemType, name := s.decodeBlobSummary(localCipher); itemType != "" || name != "" {
		return itemType, name
	}
	return s.decodeBlobSummary(remoteCipher)
}

// decodeBlobSummary 解密单个密文并读取其中的类型与名称字段。
// 任何一步失败都返回空值：描述信息只是展示辅助，不应让整个冲突列表报错。
func (s *SyncService) decodeBlobSummary(ciphertext string) (string, string) {
	mk, err := s.vault.GetMasterKey()
	if err != nil {
		return "", ""
	}
	defer func() {
		for i := range mk {
			mk[i] = 0
		}
	}()

	plain, err := crypto.UnpackAndDecrypt(ciphertext, mk)
	if err != nil {
		return "", ""
	}

	// host / key / snippet 三类条目的展示字段统一为 name
	var summary struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(plain, &summary); err != nil {
		return "", ""
	}
	return summary.Type, summary.Name
}
