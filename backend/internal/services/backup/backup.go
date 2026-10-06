// Package backup 提供保险库数据的加密导出与导入。
//
// 备份文件是本地数据库的完整快照：条目内容（主机 / 密钥 / 片段）本就是
// 由主密钥加密后的密文，而主密钥自身又被登录口令派生出的密钥加密，
// 因此文件离开本机后仍需原登录口令才能还原，可安全存放在网盘或移动介质。
package backup

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"terminator-desktop/backend/internal/api"
	"terminator-desktop/backend/internal/apperror"
	"terminator-desktop/backend/internal/crypto"
	"terminator-desktop/backend/internal/dbgen"
	"terminator-desktop/backend/internal/timeutil"
	"terminator-desktop/backend/internal/vault"

	"github.com/google/uuid"
)

const (
	// backupFormat 写入文件用于识别自身格式的标记
	backupFormat = "terminator-vault-backup"
	// backupFormatVersion 当前写入的格式版本；导入时拒绝高于本版本的文件
	backupFormatVersion = 1
	// backupFileExt 备份文件扩展名
	backupFileExt = ".json"
	// maxBackupFileSize 读取上限，防止误选超大文件把内存打满
	maxBackupFileSize = 128 << 20
)

// FileDialog 提供原生文件选择对话框。
// 由桌面层实现并注入，避免 services 层直接依赖 wails 框架。
type FileDialog interface {
	// ChooseSavePath 弹出保存对话框，返回用户选择的路径；用户取消时返回空字符串
	ChooseSavePath(defaultName string) (string, error)
	// ChooseOpenPath 弹出打开对话框，返回用户选择的路径；用户取消时返回空字符串
	ChooseOpenPath() (string, error)
}

// SessionDisconnector 断开所有 SSH 会话的接口（避免循环依赖）
type SessionDisconnector interface {
	DisconnectAll()
}

// SyncPauser 暂停后台同步的接口（避免循环依赖）。
// 导入会整体替换本地数据，必须确保期间没有同步在跑。
type SyncPauser interface {
	PauseSync() func()
}

// BackupUser 备份中的账户记录。
// 仅包含派生密钥所需的盐值与被口令加密的主密钥，不含任何明文密钥。
type BackupUser struct {
	Username           string `json:"username"`
	KeySalt            string `json:"keySalt"`
	AuthSalt           string `json:"authSalt"`
	EncryptedMasterKey string `json:"encryptedMasterKey"`
	ServerURL          string `json:"serverUrl,omitempty"`
	LastSyncTime       string `json:"lastSyncTime,omitempty"`
}

// BackupBlob 备份中的单条密文记录。
type BackupBlob struct {
	ID        string `json:"id"`
	Blob      string `json:"blob"`
	UpdatedAt string `json:"updatedAt"`
	IsDeleted bool   `json:"isDeleted"`
}

type backupPayload struct {
	Format     string       `json:"format"`
	Version    int          `json:"version"`
	AppVersion string       `json:"appVersion"`
	ExportedAt string       `json:"exportedAt"`
	User       BackupUser   `json:"user"`
	Blobs      []BackupBlob `json:"blobs"`
}

// BackupFileInfo 备份文件摘要，供导入前向用户确认内容。
type BackupFileInfo struct {
	FileName   string `json:"fileName"`
	Username   string `json:"username"`
	AppVersion string `json:"appVersion"`
	ExportedAt string `json:"exportedAt"`
	ItemCount  int    `json:"itemCount"`
}

type BackupService struct {
	q       *dbgen.Queries
	db      *sql.DB
	vault   *vault.Vault
	client  *api.Client
	dialog  FileDialog
	version func() string

	sshDisconn SessionDisconnector
	syncPauser SyncPauser

	mu sync.Mutex
	// pending 记录 SelectBackupFile 选中的备份。
	// 导入只接受这里缓存的路径，不接受前端传入的任意路径，
	// 否则该接口会变成任意文件读取通道。
	pending *backupPayload
	// importing 标记导入进行中，阻止并发重入导致的两次整体替换交错
	importing bool
}

func NewBackupService(
	q *dbgen.Queries,
	db *sql.DB,
	v *vault.Vault,
	client *api.Client,
	dialog FileDialog,
	version func() string) *BackupService {
	return &BackupService{
		q:       q,
		db:      db,
		vault:   v,
		client:  client,
		dialog:  dialog,
		version: version,
	}
}

// SetSessionDisconnector 注入 SSH 服务引用，导入前断开所有连接。
// 导入会整体替换主机列表，留着旧会话没有意义，且会持有已不存在的主机记录。
//
//wails:ignore 仅由后端装配（main.go）调用，参数是接口类型无法 JSON 序列化，不暴露给前端
func (s *BackupService) SetSessionDisconnector(d SessionDisconnector) {
	s.sshDisconn = d
}

// SetSyncPauser 注入同步服务引用，导入前暂停后台同步。
// 否则在途同步会把导入前的旧条目推送到服务器，覆盖掉刚恢复的数据。
//
//wails:ignore 仅由后端装配（main.go）调用，参数是接口类型无法 JSON 序列化，不暴露给前端
func (s *BackupService) SetSyncPauser(p SyncPauser) {
	s.syncPauser = p
}

func (s *BackupService) appVersion() string {
	if s.version == nil {
		return ""
	}
	return s.version()
}

// ExportBackup 导出加密备份到用户选择的文件，返回写入的路径。
// 用户在对话框中取消时返回空路径且不报错。
func (s *BackupService) ExportBackup(ctx context.Context) (string, error) {
	if !s.vault.IsUnlocked() {
		return "", apperror.VaultLocked()
	}

	user, err := s.q.GetUser(ctx)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", apperror.NotFound("no account to export", err)
		}
		return "", err
	}

	blobs, err := s.q.GetAllBlobs(ctx)
	if err != nil {
		return "", err
	}

	payload := backupPayload{
		Format:     backupFormat,
		Version:    backupFormatVersion,
		AppVersion: s.appVersion(),
		ExportedAt: timeutil.Now(),
		User: BackupUser{
			Username:           user.Username,
			KeySalt:            user.KeySalt,
			AuthSalt:           user.AuthSalt.String,
			EncryptedMasterKey: user.EncryptedMasterKey,
			ServerURL:          user.ServerUrl.String,
			LastSyncTime:       user.LastSyncTime.String,
		},
		Blobs: make([]BackupBlob, 0, len(blobs)),
	}
	for _, b := range blobs {
		payload.Blobs = append(payload.Blobs, BackupBlob{
			ID:        b.ID,
			Blob:      b.Blob,
			UpdatedAt: b.UpdatedAt,
			IsDeleted: b.IsDeleted,
		})
	}

	data, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return "", err
	}

	defaultName := fmt.Sprintf("terminator-backup-%s%s", time.Now().Format("20060102-150405"), backupFileExt)

	path, err := s.dialog.ChooseSavePath(defaultName)
	if err != nil {
		return "", err
	}
	if path == "" {
		return "", nil
	}
	if !strings.HasSuffix(strings.ToLower(path), backupFileExt) {
		path += backupFileExt
	}

	// 原子写：先写临时文件再改名，避免中途失败留下半截备份被误当作可用文件
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return path, nil
}

// SelectBackupFile 弹出文件选择框并解析备份摘要，暂存文件内容供 ImportBackup 使用。
// 用户在对话框中取消时返回 nil 且不报错。
func (s *BackupService) SelectBackupFile() (*BackupFileInfo, error) {
	path, err := s.dialog.ChooseOpenPath()
	if err != nil {
		return nil, err
	}
	if path == "" {
		return nil, nil
	}

	payload, err := readBackupFile(path)
	if err != nil {
		return nil, err
	}

	s.mu.Lock()
	s.pending = payload
	s.mu.Unlock()

	return &BackupFileInfo{
		FileName:   filepath.Base(path),
		Username:   payload.User.Username,
		AppVersion: payload.AppVersion,
		ExportedAt: payload.ExportedAt,
		ItemCount:  len(payload.Blobs),
	}, nil
}

// ImportBackup 用备份密码解密并恢复备份，整体替换本地账户与全部条目。
//
// 密码必须与导出时一致：先用它解密备份中的主密钥，解密失败即判定密码不符并中止，
// 不会写入任何数据。这样可避免恢复出一份当前口令打不开的保险库。
func (s *BackupService) ImportBackup(ctx context.Context, password string) error {
	if password == "" {
		return apperror.Validation("backup password is required")
	}

	// 整体替换数据不可重入：前端禁用按钮仍挡不住回车提交等竞态窗口，
	// 两次导入交错会得到用户无法预期的混合结果
	s.mu.Lock()
	if s.importing {
		s.mu.Unlock()
		return apperror.Validation("another restore is already in progress")
	}
	payload := s.pending
	if payload == nil {
		s.mu.Unlock()
		return apperror.Validation("no backup file selected")
	}
	s.importing = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.importing = false
		s.mu.Unlock()
	}()

	kek, err := crypto.DeriveKEK(password, payload.User.KeySalt)
	if err != nil {
		return err
	}
	defer clearBytes(kek)

	masterKey, err := crypto.UnpackAndDecrypt(payload.User.EncryptedMasterKey, kek)
	if err != nil {
		return apperror.Validation("备份密码不正确，无法解密备份")
	}
	defer clearBytes(masterKey)

	loginKey, err := crypto.DeriveLoginKey(password, payload.User.AuthSalt)
	if err != nil {
		return err
	}
	defer clearBytes(loginKey)

	// 密码校验通过、确认要替换数据后再暂停同步：暂停会等待在途同步结束，
	// 密码错误时不应无谓地阻塞同步循环
	if s.syncPauser != nil {
		resume := s.syncPauser.PauseSync()
		defer resume()
	}

	// 主机列表将被整体替换，先断开所有 SSH 会话与端口转发
	if s.sshDisconn != nil {
		func() {
			defer func() {
				// 断开失败不应阻断恢复流程
				_ = recover()
			}()
			s.sshDisconn.DisconnectAll()
		}()
	}

	// 事务写入：避免出现条目已替换但账户仍是旧的半恢复状态
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	qtx := s.q.WithTx(tx)
	if err := qtx.WipeBlobs(ctx); err != nil {
		return err
	}
	// 冲突记录引用的是被替换掉的旧密文，必须一并清除
	if err := qtx.WipeConflicts(ctx); err != nil {
		return err
	}
	if err := qtx.WipeUsers(ctx); err != nil {
		return err
	}

	user := payload.User
	// 备份格式不记录用户 ID（ID 不参与密钥派生），恢复时重新生成
	if err := qtx.CreateUser(ctx, dbgen.CreateUserParams{
		ID:                 uuid.New().String(),
		Username:           user.Username,
		KeySalt:            user.KeySalt,
		AuthSalt:           sql.NullString{String: user.AuthSalt, Valid: user.AuthSalt != ""},
		EncryptedMasterKey: user.EncryptedMasterKey,
		ServerUrl:          sql.NullString{String: user.ServerURL, Valid: user.ServerURL != ""},
		LastSyncTime:       sql.NullString{String: user.LastSyncTime, Valid: user.LastSyncTime != ""},
	}); err != nil {
		return err
	}

	for _, b := range payload.Blobs {
		if err := qtx.UpsertBlob(ctx, dbgen.UpsertBlobParams{
			ID:        b.ID,
			Blob:      b.Blob,
			UpdatedAt: b.UpdatedAt,
			IsDeleted: b.IsDeleted,
		}); err != nil {
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	// 旧 token 属于被替换掉的账户，必须丢弃
	s.client.ClearToken()
	// 直接用备份口令解锁：备份已校验可解密，无需用户重新登录
	s.vault.Unlock(masterKey, loginKey)

	s.mu.Lock()
	s.pending = nil
	s.mu.Unlock()

	return nil
}

// readBackupFile 读取并校验备份文件结构。
func readBackupFile(path string) (*backupPayload, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if info.Size() > maxBackupFileSize {
		return nil, apperror.Validation("备份文件过大，无法读取")
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var payload backupPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, apperror.Validation("备份文件内容无法解析")
	}
	if payload.Format != backupFormat {
		return nil, apperror.Validation("所选文件不是 Terminator 备份")
	}
	if payload.Version > backupFormatVersion {
		return nil, apperror.Validation("备份文件版本高于当前应用，请先升级应用")
	}
	if payload.User.Username == "" || payload.User.KeySalt == "" ||
		payload.User.AuthSalt == "" || payload.User.EncryptedMasterKey == "" {
		return nil, apperror.Validation("备份文件缺少账户信息，无法恢复")
	}

	return &payload, nil
}

// clearBytes 清零敏感密钥切片，避免明文密钥驻留内存等待 GC。
func clearBytes(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
