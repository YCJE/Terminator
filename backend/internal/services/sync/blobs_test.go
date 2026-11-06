package sync

import (
	"context"
	"database/sql"
	"testing"
	"time"

	_ "modernc.org/sqlite"

	"terminator-desktop/backend/internal/dbgen"
	"terminator-desktop/backend/internal/migration"
	"terminator-desktop/backend/internal/timeutil"
)

// newTestDB 创建带完整迁移的内存数据库。
// 内存数据库按连接隔离，限制为单连接以保证迁移建表与后续查询命中同一个库。
func newTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("打开内存数据库失败: %v", err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })

	if err := migration.RunMigrations(db); err != nil {
		t.Fatalf("执行迁移失败: %v", err)
	}
	return db
}

func newTestQueries(t *testing.T) *dbgen.Queries {
	return dbgen.New(newTestDB(t))
}

func getBlob(t *testing.T, q *dbgen.Queries, id string) dbgen.EncryptedBlob {
	t.Helper()
	blobs, err := q.GetActiveBlobs(context.Background())
	if err != nil {
		t.Fatalf("查询 blob 失败: %v", err)
	}
	for _, b := range blobs {
		if b.ID == id {
			return b
		}
	}
	t.Fatalf("未找到 blob %q", id)
	return dbgen.EncryptedBlob{}
}

// UpsertBlobIfNewer 必须仅在服务端副本严格更新时才覆盖本地。
// 若旧副本能覆盖本地新编辑，该编辑会因时间戳回退到同步游标之前而永久丢失。
func TestUpsertBlobIfNewerKeepsLocalWhenRemoteOlder(t *testing.T) {
	ctx := context.Background()
	q := newTestQueries(t)

	const id = "blob-1"
	if err := q.UpsertBlob(ctx, dbgen.UpsertBlobParams{
		ID:        id,
		Blob:      "local-new",
		UpdatedAt: "2026-07-05T09:17:38.000000000Z",
	}); err != nil {
		t.Fatalf("写入本地新副本失败: %v", err)
	}

	// 来自另一台设备的旧副本：不得覆盖本地
	if err := q.UpsertBlobIfNewer(ctx, dbgen.UpsertBlobIfNewerParams{
		ID:        id,
		Blob:      "remote-old",
		UpdatedAt: "2026-07-05T09:17:37.000000000Z",
	}); err != nil {
		t.Fatalf("条件 upsert 失败: %v", err)
	}
	if got := getBlob(t, q, id); got.Blob != "local-new" {
		t.Errorf("旧副本覆盖了本地新副本: blob=%q", got.Blob)
	}
}

// 时间戳相同时保留本地，避免多端在同一时刻写入导致互相覆盖。
func TestUpsertBlobIfNewerKeepsLocalWhenEqual(t *testing.T) {
	ctx := context.Background()
	q := newTestQueries(t)

	const id = "blob-eq"
	const ts = "2026-07-05T09:17:38.000000000Z"
	if err := q.UpsertBlob(ctx, dbgen.UpsertBlobParams{ID: id, Blob: "local", UpdatedAt: ts}); err != nil {
		t.Fatalf("写入本地副本失败: %v", err)
	}
	if err := q.UpsertBlobIfNewer(ctx, dbgen.UpsertBlobIfNewerParams{ID: id, Blob: "remote", UpdatedAt: ts}); err != nil {
		t.Fatalf("条件 upsert 失败: %v", err)
	}
	if got := getBlob(t, q, id); got.Blob != "local" {
		t.Errorf("同时间戳时本地副本被覆盖: blob=%q", got.Blob)
	}
}

// 服务端副本更新时必须覆盖本地，否则永远拿不到其他设备的改动。
func TestUpsertBlobIfNewerOverwritesWhenRemoteNewer(t *testing.T) {
	ctx := context.Background()
	q := newTestQueries(t)

	const id = "blob-2"
	if err := q.UpsertBlob(ctx, dbgen.UpsertBlobParams{
		ID:        id,
		Blob:      "local-old",
		UpdatedAt: "2026-07-05T09:17:37.000000000Z",
	}); err != nil {
		t.Fatalf("写入本地副本失败: %v", err)
	}
	if err := q.UpsertBlobIfNewer(ctx, dbgen.UpsertBlobIfNewerParams{
		ID:        id,
		Blob:      "remote-new",
		UpdatedAt: "2026-07-05T09:17:39.000000000Z",
	}); err != nil {
		t.Fatalf("条件 upsert 失败: %v", err)
	}
	if got := getBlob(t, q, id); got.Blob != "remote-new" {
		t.Errorf("更新的服务端副本未覆盖本地: blob=%q", got.Blob)
	}
}

// 无冲突时应正常插入新行，不受 DO UPDATE 的 WHERE 子句影响。
func TestUpsertBlobIfNewerInsertsNewRow(t *testing.T) {
	ctx := context.Background()
	q := newTestQueries(t)

	if err := q.UpsertBlobIfNewer(ctx, dbgen.UpsertBlobIfNewerParams{
		ID:        "blob-new",
		Blob:      "fresh",
		UpdatedAt: "2026-07-05T09:17:37.000000000Z",
	}); err != nil {
		t.Fatalf("条件 upsert 插入失败: %v", err)
	}
	if got := getBlob(t, q, "blob-new"); got.Blob != "fresh" {
		t.Errorf("新记录未插入: blob=%q", got.Blob)
	}
}

// 定长时间戳的字典序必须与时间序一致，这是 GetBlobsSince 文本比较的前提。
func TestGetBlobsSinceUsesLexicographicBound(t *testing.T) {
	ctx := context.Background()
	q := newTestQueries(t)

	rows := []struct {
		id string
		ts string
	}{
		{"b-early", "2026-07-05T09:17:37.000000000Z"},
		{"b-bound", "2026-07-05T09:17:38.000000000Z"},
		{"b-late", "2026-07-05T09:17:39.000000000Z"},
	}
	for _, r := range rows {
		if err := q.UpsertBlob(ctx, dbgen.UpsertBlobParams{ID: r.id, Blob: r.id, UpdatedAt: r.ts}); err != nil {
			t.Fatalf("写入 %s 失败: %v", r.id, err)
		}
	}

	got, err := q.GetBlobsSince(ctx, "2026-07-05T09:17:38.000000000Z")
	if err != nil {
		t.Fatalf("GetBlobsSince 失败: %v", err)
	}
	if len(got) != 1 || got[0].ID != "b-late" {
		t.Errorf("增量查询边界错误: %+v", got)
	}
}

// 冲突解决写回的时间戳必须严格晚于双方快照：否则服务端按「较新者生效」
// 合并时仍会保留较新的旧副本，用户的选择在下一轮同步被覆盖回去。
func TestConflictResolutionTimeStrictlyNewer(t *testing.T) {
	future := timeutil.Format(time.Now().Add(time.Hour))
	got := conflictResolutionTime("", future)
	gotTime, err := timeutil.Parse(got)
	if err != nil {
		t.Fatalf("解析结果时间戳失败: %v", err)
	}
	remote, err := timeutil.Parse(future)
	if err != nil {
		t.Fatalf("解析远端时间戳失败: %v", err)
	}
	if !gotTime.After(remote) {
		t.Errorf("写回时间 %s 未严格晚于远端 %s", got, future)
	}

	// 两端都是过去时间时，结果至少晚于较新的那一端
	past := timeutil.Format(time.Now().Add(-time.Hour))
	got = conflictResolutionTime(past, past)
	gotTime, err = timeutil.Parse(got)
	if err != nil {
		t.Fatalf("解析结果时间戳失败: %v", err)
	}
	pastTime, err := timeutil.Parse(past)
	if err != nil {
		t.Fatalf("解析过去时间戳失败: %v", err)
	}
	if !gotTime.After(pastTime) {
		t.Errorf("写回时间 %s 未严格晚于快照 %s", got, past)
	}

	// 非法时间戳不应让结果失控：回退到当前时间
	got = conflictResolutionTime("not-a-time", "")
	gotTime, err = timeutil.Parse(got)
	if err != nil {
		t.Fatalf("解析回退时间戳失败: %v", err)
	}
	if time.Since(gotTime) > time.Minute {
		t.Errorf("非法输入时未回退到当前时间: %s", got)
	}
}
