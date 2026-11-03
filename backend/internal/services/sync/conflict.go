package sync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

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

// conflictResolutionTime 计算冲突解决后写回本地的时间戳。
//
// 仅用本地当前时间并不够：远端副本可能带有更晚的时间戳（对端时钟领先，
// 或服务端返回的 SyncTime 已前移），服务端按「较新者生效」合并时仍会保留
// 远端副本，下一轮同步又把用户刚选定的内容覆盖回去、冲突重新出现。
// 因此取「本地当前时间」与「双方快照时间 + 1ns」中的最大值，
// 保证选中的副本严格晚于两端旧值，无论选择哪一端都能稳定生效。
func conflictResolutionTime(localAt, remoteAt string) string {
	chosen := timeutil.Now()
	latest, err := timeutil.Parse(chosen)
	if err != nil {
		latest = time.Now()
	}
	for _, s := range []string{localAt, remoteAt} {
		t, err := timeutil.Parse(s)
		if err != nil {
			continue
		}
		if cand := t.Add(time.Nanosecond); cand.After(latest) {
			latest = cand
		}
	}
	return timeutil.Format(latest)
}

// ResolveConflict 按用户选择保留冲突中的一端：keepLocal 为 true 保留本地副本，
// 否则保留远端副本。
//
// 选中的副本以「严格晚于双方旧值」的时间写回本地（见 conflictResolutionTime），
// 因此它晚于本轮同步游标，会在下一轮同步中上传并覆盖另一端；
// 不这样做的话本地会一直停留在落败的旧值上反复产生冲突。
func (s *SyncService) ResolveConflict(ctx context.Context, blobID string, keepLocal bool) error {
	if !s.vault.IsUnlocked() {
		return apperror.VaultLocked()
	}

	// 纳入 syncGate：与在途同步互斥，避免与 Sync 并发写同一行 blob / 游标
	s.syncGate.Lock()
	defer s.syncGate.Unlock()

	// 读取快照与写回必须原子：UpsertBlob 与 DeleteConflict 只要成功一半，
	// 选 keepRemote 的用户就会因本地副本已变成远端值而永远无法再次通过校验。
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	qtx := s.q.WithTx(tx)

	conflict, err := qtx.GetConflict(ctx, blobID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return apperror.NotFound("conflict not found", err)
		}
		return err
	}

	// 校验当前本地副本仍与冲突快照一致：冲突产生后用户可能又编辑过该条目
	// （或对端已有第三个版本）。若不一致，用旧快照写回会静默丢弃较新的修改，
	// 因此拒绝并要求用户重新查看冲突后再选择。
	current, err := qtx.GetBlobByID(ctx, blobID)
	switch {
	case err == nil:
		// 两步写回已在同一事务内完成，不会出现「时间戳已改而冲突未删」的半成功
		// 状态，因此恢复严格校验：任一字段与快照不一致都拒绝。
		if current.Blob != conflict.LocalBlob ||
			current.UpdatedAt != conflict.LocalUpdatedAt ||
			current.IsDeleted != conflict.LocalDeleted {
			return apperror.Validation("本地副本在冲突产生后已被修改，请重新查看冲突后再选择")
		}
	case errors.Is(err, sql.ErrNoRows):
		return apperror.Validation("本地副本已不存在，无法按冲突快照写回")
	default:
		return err
	}

	chosen := dbgen.UpsertBlobParams{
		ID:        blobID,
		UpdatedAt: conflictResolutionTime(conflict.LocalUpdatedAt, conflict.RemoteUpdatedAt),
	}
	if keepLocal {
		chosen.Blob = conflict.LocalBlob
		chosen.IsDeleted = conflict.LocalDeleted
	} else {
		chosen.Blob = conflict.RemoteBlob
		chosen.IsDeleted = conflict.RemoteDeleted
	}

	if err := qtx.UpsertBlob(ctx, chosen); err != nil {
		return err
	}
	if err := qtx.DeleteConflict(ctx, blobID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
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
