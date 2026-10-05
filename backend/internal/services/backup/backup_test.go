package backup

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"

	"terminator-desktop/backend/internal/api"
	"terminator-desktop/backend/internal/crypto"
	"terminator-desktop/backend/internal/dbgen"
	"terminator-desktop/backend/internal/migration"
	"terminator-desktop/backend/internal/vault"
)

// fakeDialog 把"用户选择的路径"固定为预设值，避免测试依赖真实文件对话框。
type fakeDialog struct {
	savePath string
	openPath string
}

func (d *fakeDialog) ChooseSavePath(string) (string, error) { return d.savePath, nil }
func (d *fakeDialog) ChooseOpenPath() (string, error)       { return d.openPath, nil }

const testPassword = "correct-horse-battery"

func newTestService(t *testing.T) (*BackupService, *dbgen.Queries, *vault.Vault, *fakeDialog) {
	t.Helper()

	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatalf("打开内存数据库失败: %v", err)
	}
	// 内存数据库按连接隔离，限制为单连接保证迁移与后续查询命中同一个库
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })

	if err := migration.RunMigrations(db); err != nil {
		t.Fatalf("执行迁移失败: %v", err)
	}

	q := dbgen.New(db)
	v := vault.New()
	dialog := &fakeDialog{}
	svc := NewBackupService(q, db, v, api.NewClient(), dialog, func() string { return "test" })

	return svc, q, v, dialog
}

// seedAccount 写入一个与真实注册流程等价的账户，并解锁保险库。
// 返回主密钥，供断言恢复后的密钥是否一致。
func seedAccount(t *testing.T, q *dbgen.Queries, v *vault.Vault) []byte {
	t.Helper()
	ctx := context.Background()

	masterKey := bytes.Repeat([]byte{0x11}, 32)
	keySalt := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x22}, 16))
	authSalt := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x33}, 16))

	kek, err := crypto.DeriveKEK(testPassword, keySalt)
	if err != nil {
		t.Fatalf("派生 KEK 失败: %v", err)
	}
	encryptedMasterKey, err := crypto.EncryptAndPack(masterKey, kek)
	if err != nil {
		t.Fatalf("加密主密钥失败: %v", err)
	}
	loginKey, err := crypto.DeriveLoginKey(testPassword, authSalt)
	if err != nil {
		t.Fatalf("派生登录密钥失败: %v", err)
	}

	if err := q.CreateUser(ctx, dbgen.CreateUserParams{
		ID:                 "user-1",
		Username:           "alice",
		KeySalt:            keySalt,
		AuthSalt:           sql.NullString{String: authSalt, Valid: true},
		EncryptedMasterKey: encryptedMasterKey,
		ServerUrl:          sql.NullString{String: "https://sync.example.com", Valid: true},
		LastSyncTime:       sql.NullString{String: "2026-07-05T09:17:38.000000000Z", Valid: true},
	}); err != nil {
		t.Fatalf("写入用户失败: %v", err)
	}

	v.Unlock(masterKey, loginKey)
	return masterKey
}

func seedBlob(t *testing.T, q *dbgen.Queries, masterKey []byte, id, name string) string {
	t.Helper()
	plain, err := json.Marshal(map[string]string{"type": "host", "name": name})
	if err != nil {
		t.Fatalf("序列化条目失败: %v", err)
	}
	packed, err := crypto.EncryptAndPack(plain, masterKey)
	if err != nil {
		t.Fatalf("加密条目失败: %v", err)
	}
	if err := q.UpsertBlob(context.Background(), dbgen.UpsertBlobParams{
		ID:        id,
		Blob:      packed,
		UpdatedAt: "2026-07-05T09:17:38.000000000Z",
	}); err != nil {
		t.Fatalf("写入条目失败: %v", err)
	}
	return packed
}

// 导出后再导入必须完整还原账户与条目，且恢复后的主密钥与导出前一致。
func TestExportImportRoundTrip(t *testing.T) {
	ctx := context.Background()
	svc, q, v, dialog := newTestService(t)

	masterKey := seedAccount(t, q, v)
	blobID := "blob-1"
	packed := seedBlob(t, q, masterKey, blobID, "web-1")

	path := filepath.Join(t.TempDir(), "backup.json")
	dialog.savePath = path

	exported, err := svc.ExportBackup(ctx)
	if err != nil {
		t.Fatalf("导出失败: %v", err)
	}
	if exported != path {
		t.Fatalf("导出路径不符: got %q want %q", exported, path)
	}

	// 模拟全新安装：清空数据并锁定保险库
	if err := q.WipeBlobs(ctx); err != nil {
		t.Fatalf("清空条目失败: %v", err)
	}
	if err := q.WipeUsers(ctx); err != nil {
		t.Fatalf("清空用户失败: %v", err)
	}
	v.Lock()

	dialog.openPath = path
	info, err := svc.SelectBackupFile()
	if err != nil {
		t.Fatalf("选择备份失败: %v", err)
	}
	if info == nil {
		t.Fatal("选择备份返回空摘要")
	}
	if info.Username != "alice" || info.ItemCount != 1 {
		t.Errorf("备份摘要不符: %+v", info)
	}

	if err := svc.ImportBackup(ctx, testPassword); err != nil {
		t.Fatalf("导入失败: %v", err)
	}

	user, err := q.GetUser(ctx)
	if err != nil {
		t.Fatalf("读取恢复后的用户失败: %v", err)
	}
	if user.Username != "alice" {
		t.Errorf("用户名未恢复: %q", user.Username)
	}
	if user.ServerUrl.String != "https://sync.example.com" || !user.ServerUrl.Valid {
		t.Errorf("服务器地址未恢复: %+v", user.ServerUrl)
	}
	if user.LastSyncTime.String != "2026-07-05T09:17:38.000000000Z" {
		t.Errorf("同步游标未恢复: %q", user.LastSyncTime.String)
	}

	blobs, err := q.GetAllBlobs(ctx)
	if err != nil {
		t.Fatalf("读取恢复后的条目失败: %v", err)
	}
	if len(blobs) != 1 || blobs[0].ID != blobID || blobs[0].Blob != packed {
		t.Fatalf("条目未按原样恢复: %+v", blobs)
	}

	// 恢复后保险库应已解锁，且密钥与导出前一致（否则条目无法解密）
	if !v.IsUnlocked() {
		t.Fatal("导入后保险库仍处于锁定状态")
	}
	restoredKey, err := v.GetMasterKey()
	if err != nil {
		t.Fatalf("读取主密钥失败: %v", err)
	}
	if !bytes.Equal(restoredKey, masterKey) {
		t.Error("恢复后的主密钥与导出前不一致")
	}
	if _, err := crypto.UnpackAndDecrypt(blobs[0].Blob, restoredKey); err != nil {
		t.Errorf("恢复后的条目无法解密: %v", err)
	}
}

// 密码不符时必须中止导入且不写入任何数据，避免恢复出当前口令打不开的保险库。
func TestImportRejectsWrongPassword(t *testing.T) {
	ctx := context.Background()
	svc, q, v, dialog := newTestService(t)

	masterKey := seedAccount(t, q, v)
	seedBlob(t, q, masterKey, "blob-1", "web-1")

	path := filepath.Join(t.TempDir(), "backup.json")
	dialog.savePath = path
	if _, err := svc.ExportBackup(ctx); err != nil {
		t.Fatalf("导出失败: %v", err)
	}

	if err := q.WipeBlobs(ctx); err != nil {
		t.Fatalf("清空条目失败: %v", err)
	}
	if err := q.WipeUsers(ctx); err != nil {
		t.Fatalf("清空用户失败: %v", err)
	}
	// 模拟全新安装：数据已清空且保险库处于锁定状态。
	// seedAccount 会解锁保险库，若不在此锁回，就无法验证导入失败时
	// 保险库仍保持锁定（而非被这次失败的操作解锁）。
	v.Lock()

	dialog.openPath = path
	if _, err := svc.SelectBackupFile(); err != nil {
		t.Fatalf("选择备份失败: %v", err)
	}

	if err := svc.ImportBackup(ctx, "wrong-password"); err == nil {
		t.Fatal("错误密码竟然导入成功")
	}

	// 事务未提交：用户表应仍为空，保险库保持锁定
	if _, err := q.GetUser(ctx); err == nil {
		t.Error("导入失败后用户表被写入")
	}
	if v.IsUnlocked() {
		t.Error("导入失败后保险库被解锁")
	}
}

// 未选择备份文件时直接导入应被拒绝，防止误触发清空数据。
func TestImportWithoutSelection(t *testing.T) {
	svc, _, _, _ := newTestService(t)
	if err := svc.ImportBackup(context.Background(), testPassword); err == nil {
		t.Fatal("未选择备份文件却导入成功")
	}
}

// 非本应用产生的 JSON 文件必须被拒绝，避免误把其他文件当作备份导入。
func TestReadBackupFileRejectsForeignFormat(t *testing.T) {
	path := filepath.Join(t.TempDir(), "foreign.json")
	if err := os.WriteFile(path, []byte(`{"format":"other","version":1}`), 0600); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}
	if _, err := readBackupFile(path); err == nil {
		t.Fatal("非备份文件竟然通过校验")
	}
}

// 版本高于当前应用时必须拒绝，避免用旧客户端解析未来格式导致数据损坏。
func TestReadBackupFileRejectsNewerVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "newer.json")
	payload := backupPayload{
		Format:  backupFormat,
		Version: backupFormatVersion + 1,
		User: BackupUser{
			Username:           "alice",
			KeySalt:            "salt",
			AuthSalt:           "salt",
			EncryptedMasterKey: "key",
		},
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatalf("写入测试文件失败: %v", err)
	}
	if _, err := readBackupFile(path); err == nil {
		t.Fatal("高版本备份竟然通过校验")
	}
}

// 保险库锁定时不得导出：此时无法确认账户与密文的归属。
func TestExportRequiresUnlockedVault(t *testing.T) {
	svc, _, _, _ := newTestService(t)
	if _, err := svc.ExportBackup(context.Background()); err == nil {
		t.Fatal("保险库锁定时导出竟然成功")
	}
}
