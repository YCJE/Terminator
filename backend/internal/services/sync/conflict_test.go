package sync

import (
	"bytes"
	"context"
	"testing"

	"terminator-desktop/backend/internal/dbgen"
	"terminator-desktop/backend/internal/timeutil"
	"terminator-desktop/backend/internal/vault"
)

// noopEmitter 满足 SyncEmitter，仅用于只关注数据库写入的测试。
type noopEmitter struct{}

func (noopEmitter) EmitStatus(SyncStatus) {}
func (noopEmitter) EmitUpdatesAvailable() {}
func (noopEmitter) EmitSyncError(error)   {}

func newConflictTestService(t *testing.T) (*SyncService, *dbgen.Queries) {
	t.Helper()
	db := newTestDB(t)
	q := dbgen.New(db)
	v := vault.New()
	v.Unlock(bytes.Repeat([]byte{0x11}, 32), bytes.Repeat([]byte{0x22}, 32))
	return &SyncService{q: q, db: db, vault: v, emitter: noopEmitter{}}, q
}

// 远端较新时同步已按"较新者生效"把本地行覆盖成远端快照；
// 用户此时选择"保留本地"必须仍能恢复冲突快照里的本地副本，
// 否则用户被覆盖的修改永远无法恢复（旧实现严格校验 Local* 快照，必然拒绝）。
func TestResolveConflictKeepLocalAfterRemoteOverwrite(t *testing.T) {
	ctx := context.Background()
	svc, q := newConflictTestService(t)

	const (
		blobID   = "blob-1"
		localAt  = "2026-07-05T09:17:38.000000000Z"
		remoteAt = "2026-07-05T09:17:40.000000000Z"
	)
	if err := q.UpsertConflict(ctx, dbgen.UpsertConflictParams{
		BlobID:          blobID,
		LocalBlob:       "local-version",
		RemoteBlob:      "remote-version",
		LocalUpdatedAt:  localAt,
		RemoteUpdatedAt: remoteAt,
		DetectedAt:      remoteAt,
	}); err != nil {
		t.Fatalf("写入冲突失败: %v", err)
	}
	// 模拟同步写回：本地行已变成远端快照
	if err := q.UpsertBlob(ctx, dbgen.UpsertBlobParams{
		ID: blobID, Blob: "remote-version", UpdatedAt: remoteAt,
	}); err != nil {
		t.Fatalf("写入本地副本失败: %v", err)
	}

	if err := svc.ResolveConflict(ctx, blobID, true); err != nil {
		t.Fatalf("远端已覆盖本地时仍应允许保留本地副本: %v", err)
	}

	got, err := q.GetBlobByID(ctx, blobID)
	if err != nil {
		t.Fatalf("读取解决后的条目失败: %v", err)
	}
	if got.Blob != "local-version" {
		t.Errorf("未保留本地副本: blob=%q", got.Blob)
	}
	// 写回时间必须严格晚于双方快照，否则下一轮同步不会上传该副本
	resolved, err := timeutil.Parse(got.UpdatedAt)
	if err != nil {
		t.Fatalf("解析写回时间失败: %v", err)
	}
	remoteTime, _ := timeutil.Parse(remoteAt)
	if !resolved.After(remoteTime) {
		t.Errorf("写回时间 %q 未晚于远端快照 %q", got.UpdatedAt, remoteAt)
	}
	if _, err := q.GetConflict(ctx, blobID); err == nil {
		t.Error("冲突记录未删除")
	}
}

// 冲突产生后本地又出现第三个版本时，用旧快照写回会静默丢弃新修改，必须拒绝。
func TestResolveConflictRejectsThirdVersion(t *testing.T) {
	ctx := context.Background()
	svc, q := newConflictTestService(t)

	const (
		blobID   = "blob-2"
		localAt  = "2026-07-05T09:17:38.000000000Z"
		remoteAt = "2026-07-05T09:17:40.000000000Z"
	)
	if err := q.UpsertConflict(ctx, dbgen.UpsertConflictParams{
		BlobID:          blobID,
		LocalBlob:       "local-version",
		RemoteBlob:      "remote-version",
		LocalUpdatedAt:  localAt,
		RemoteUpdatedAt: remoteAt,
		DetectedAt:      remoteAt,
	}); err != nil {
		t.Fatalf("写入冲突失败: %v", err)
	}
	if err := q.UpsertBlob(ctx, dbgen.UpsertBlobParams{
		ID: blobID, Blob: "third-version", UpdatedAt: "2026-07-05T09:17:41.000000000Z",
	}); err != nil {
		t.Fatalf("写入第三方副本失败: %v", err)
	}

	if err := svc.ResolveConflict(ctx, blobID, true); err == nil {
		t.Fatal("存在第三个版本时不应按旧快照写回")
	}
	// 过期冲突必须被清除：否则它会永久留在列表里，任何选择都被拒绝，
	// 用户既无法解决也无法删除。
	if _, err := q.GetConflict(ctx, blobID); err == nil {
		t.Error("过期的冲突记录未清除")
	}
}

// 并发编辑判定：只有两端都晚于同步下界各自改动、且密文不同才算冲突。
// 密文相同说明两端内容一致（服务端回显我们刚推送的副本也属于这种情况），
// 不能误报为冲突。
func TestIsConcurrentEdit(t *testing.T) {
	const bound = "2026-09-30T10:00:00.000000000Z"

	cases := []struct {
		name         string
		localCipher  string
		remoteCipher string
		localAt      string
		remoteAt     string
		want         bool
	}{
		{
			name:        "两端各自改动且密文不同",
			localCipher: "aaa", remoteCipher: "bbb",
			localAt: "2026-09-30T10:00:01.000000000Z", remoteAt: "2026-09-30T10:00:02.000000000Z",
			want: true,
		},
		{
			name:        "密文相同不算冲突",
			localCipher: "same", remoteCipher: "same",
			localAt: "2026-09-30T10:00:01.000000000Z", remoteAt: "2026-09-30T10:00:02.000000000Z",
			want: false,
		},
		{
			name:        "仅本地改动",
			localCipher: "aaa", remoteCipher: "bbb",
			localAt: "2026-09-30T10:00:01.000000000Z", remoteAt: "2026-09-30T09:59:59.000000000Z",
			want: false,
		},
		{
			name:        "仅远端改动",
			localCipher: "aaa", remoteCipher: "bbb",
			localAt: "2026-09-30T09:59:59.000000000Z", remoteAt: "2026-09-30T10:00:02.000000000Z",
			want: false,
		},
		{
			name:        "恰好在同步下界上不算改动",
			localCipher: "aaa", remoteCipher: "bbb",
			localAt: bound, remoteAt: "2026-09-30T10:00:02.000000000Z",
			want: false,
		},
		{
			name:        "时间戳无法解析时按已改动处理",
			localCipher: "aaa", remoteCipher: "bbb",
			localAt: "garbage", remoteAt: "2026-09-30T10:00:02.000000000Z",
			want: true,
		},
	}

	for _, c := range cases {
		got := isConcurrentEdit(c.localCipher, c.remoteCipher, c.localAt, c.remoteAt, bound)
		if got != c.want {
			t.Errorf("%s: isConcurrentEdit() = %v, want %v", c.name, got, c.want)
		}
	}
}

// afterBound 的退化策略：任一时间戳不可解析都视为「已改动」，
// 宁可多报一次冲突让用户确认，也不要静默丢弃修改。
func TestAfterBound(t *testing.T) {
	const bound = "2026-09-30T10:00:00.000000000Z"

	cases := []struct {
		name string
		t    string
		want bool
	}{
		{"晚于下界", "2026-09-30T10:00:00.000000001Z", true},
		{"早于下界", "2026-09-30T09:59:59.999999999Z", false},
		{"等于下界", bound, false},
		{"脏数据按已改动处理", "not-a-time", true},
	}

	for _, c := range cases {
		if got := afterBound(c.t, bound); got != c.want {
			t.Errorf("%s: afterBound(%q) = %v, want %v", c.name, c.t, got, c.want)
		}
	}
}
