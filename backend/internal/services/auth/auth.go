package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"runtime/debug"
	"terminator-desktop/backend/internal/api"
	"terminator-desktop/backend/internal/apperror"
	"terminator-desktop/backend/internal/crypto"
	"terminator-desktop/backend/internal/dbgen"
	"terminator-desktop/backend/internal/vault"
	"time"

	"github.com/google/uuid"
)

// SessionDisconnector 断开所有 SSH 会话的接口（避免循环依赖）
type SessionDisconnector interface {
	DisconnectAll()
}

type AuthService struct {
	q          *dbgen.Queries
	db         *sql.DB
	vault      *vault.Vault
	client     *api.Client
	sshDisconn SessionDisconnector
}

type UserInfo struct {
	Username  string `json:"username"`
	ServerURL string `json:"serverUrl"`
}

const (
	saltLength = 16
	keyLength  = 32
)

func NewAuthService(
	q *dbgen.Queries,
	db *sql.DB,
	vault *vault.Vault,
	client *api.Client) *AuthService {
	return &AuthService{
		q:      q,
		db:     db,
		vault:  vault,
		client: client,
	}
}

// SetSessionDisconnector 注入 SSH 服务引用，用于 WipeData 时断开所有连接
func (s *AuthService) SetSessionDisconnector(d SessionDisconnector) {
	s.sshDisconn = d
}

// generateSalt returns a new random 16-byte salt, base64 encoded
func generateSalt() (string, error) {
	salt := make([]byte, saltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(salt), nil
}

func (s *AuthService) HasUser(ctx context.Context) (bool, error) {
	count, err := s.q.HasUser(ctx)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

func (s *AuthService) RegisterLocal(ctx context.Context, username, password string) error {
	// 密码最小长度校验
	if len(password) < 6 {
		return apperror.Validation("password must be at least 6 characters")
	}

	// 防御性检查：防止通过 Wails binding 直接调用绕过 UI 守卫创建重复用户
	if exists, _ := s.HasUser(ctx); exists {
		return apperror.Validation("user already exists")
	}

	masterKey := make([]byte, keyLength)
	if _, err := rand.Read(masterKey); err != nil {
		return err
	}

	keySalt, err := generateSalt()
	if err != nil {
		return err
	}

	authSalt, err := generateSalt()
	if err != nil {
		return err
	}

	kek, err := crypto.DeriveKEK(password, keySalt)
	if err != nil {
		return err
	}

	loginKey, err := crypto.DeriveLoginKey(password, authSalt)
	if err != nil {
		// kek 已分配，需清零
		for i := range kek {
			kek[i] = 0
		}
		return err
	}

	// defer 确保无论成功或失败都清零敏感密钥切片（vault 已持有副本）
	defer func() {
		for i := range kek {
			kek[i] = 0
		}
		for i := range loginKey {
			loginKey[i] = 0
		}
		for i := range masterKey {
			masterKey[i] = 0
		}
	}()

	encryptedMasterKey, err := crypto.EncryptAndPack(masterKey, kek)
	if err != nil {
		return err
	}

	err = s.q.CreateUser(ctx, dbgen.CreateUserParams{
		ID:                 uuid.New().String(),
		Username:           username,
		KeySalt:            keySalt,
		AuthSalt:           sql.NullString{String: authSalt, Valid: true},
		EncryptedMasterKey: encryptedMasterKey,
		ServerUrl:          sql.NullString{Valid: false},
		LastSyncTime:       sql.NullString{Valid: false},
	})
	if err != nil {
		return err
	}

	s.vault.Unlock(masterKey, loginKey)
	return nil
}

// Login - "unlock vault"
func (s *AuthService) Login(ctx context.Context, password string) error {
	dbUser, err := s.q.GetUser(ctx)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			// 统一返回模糊错误，防止用户枚举攻击
			return apperror.DecryptionFailed(err)
		}
		return err
	}

	kek, err := crypto.DeriveKEK(password, dbUser.KeySalt)
	if err != nil {
		return err
	}

	// Derive login key for server sync authentication.
	// AuthSalt must be present; a NULL AuthSalt would leave loginKey as all
	// zeros, which is a predictable key. Reject instead of silently falling
	// back to a zero key.
	if !dbUser.AuthSalt.Valid || dbUser.AuthSalt.String == "" {
		// kek 已分配，需清零
		for i := range kek {
			kek[i] = 0
		}
		return apperror.Validation("auth salt is missing; vault data may be corrupted")
	}
	loginKey, err := crypto.DeriveLoginKey(password, dbUser.AuthSalt.String)
	if err != nil {
		for i := range kek {
			kek[i] = 0
		}
		return err
	}

	// defer 确保无论成功或失败都清零敏感密钥切片（vault 已持有副本）
	var masterKey []byte
	defer func() {
		for i := range kek {
			kek[i] = 0
		}
		for i := range loginKey {
			loginKey[i] = 0
		}
		for i := range masterKey {
			masterKey[i] = 0
		}
	}()

	masterKey, err = crypto.UnpackAndDecrypt(dbUser.EncryptedMasterKey, kek)
	if err != nil {
		return apperror.DecryptionFailed(err)
	}

	s.vault.Unlock(masterKey, loginKey)

	go func() {
		debug.FreeOSMemory()
	}()

	return nil
}

// LoginFromSync - "connect and restore"
func (s *AuthService) LoginFromSync(ctx context.Context, serverUrl, username, password string) error {
	// 密码最小长度校验
	if len(password) < 6 {
		return apperror.Validation("password must be at least 6 characters")
	}

	// 防御性检查：防止通过 Wails binding 直接调用绕过 UI 守卫创建重复用户
	if exists, _ := s.HasUser(ctx); exists {
		return apperror.Validation("user already exists")
	}

	preflightRes, err := s.client.Preflight(ctx, serverUrl, &api.PreflightRequest{
		Username: username,
	})
	if err != nil {
		return err
	}

	kek, err := crypto.DeriveKEK(password, preflightRes.KeySalt)
	if err != nil {
		return err
	}

	// 验证服务器返回的 AuthSalt 不为空，防止空盐派生弱密钥
	if preflightRes.AuthSalt == "" {
		for i := range kek {
			kek[i] = 0
		}
		return apperror.Validation("server returned empty auth salt")
	}
	loginKey, err := crypto.DeriveLoginKey(password, preflightRes.AuthSalt)
	if err != nil {
		for i := range kek {
			kek[i] = 0
		}
		return err
	}

	// defer 确保无论成功或失败都清零敏感密钥切片（vault 已持有副本）
	var masterKey []byte
	defer func() {
		for i := range kek {
			kek[i] = 0
		}
		for i := range loginKey {
			loginKey[i] = 0
		}
		for i := range masterKey {
			masterKey[i] = 0
		}
	}()

	loginKeyBase64 := base64.StdEncoding.EncodeToString(loginKey)
	authRes, err := s.client.Login(ctx, serverUrl, &api.LoginRequest{
		Username: username,
		LoginKey: loginKeyBase64,
	})
	if err != nil {
		return err
	}

	masterKey, err = crypto.UnpackAndDecrypt(preflightRes.EncryptedMasterKey, kek)
	if err != nil {
		return apperror.DecryptionFailed(err)
	}

	epochZero := time.Unix(0, 0).UTC().Format(time.RFC3339)
	err = s.q.CreateUser(ctx, dbgen.CreateUserParams{
		ID:                 uuid.New().String(),
		Username:           username,
		KeySalt:            preflightRes.KeySalt,
		AuthSalt:           sql.NullString{String: preflightRes.AuthSalt, Valid: true},
		EncryptedMasterKey: preflightRes.EncryptedMasterKey,
		ServerUrl:          sql.NullString{String: serverUrl, Valid: true},
		LastSyncTime:       sql.NullString{String: epochZero, Valid: true},
	})
	if err != nil {
		return err
	}

	s.client.SetToken(authRes.AccessToken)
	s.vault.Unlock(masterKey, loginKey)

	go func() {
		debug.FreeOSMemory()
	}()

	return nil
}

func (s *AuthService) RegisterOnServer(ctx context.Context, serverURL string) error {
	user, err := s.q.GetUser(ctx)
	if err != nil {
		return err
	}

	loginKey, err := s.vault.GetLoginKey()
	if err != nil {
		return err
	}
	defer func() {
		for i := range loginKey {
			loginKey[i] = 0
		}
	}()

	authRes, err := s.client.Register(ctx, serverURL, &api.RegisterRequest{
		Username:           user.Username,
		AuthSalt:           user.AuthSalt.String,
		KeySalt:            user.KeySalt,
		EncryptedMasterKey: user.EncryptedMasterKey,
		LoginKey:           base64.StdEncoding.EncodeToString(loginKey),
	})
	if err != nil {
		return err
	}

	s.client.SetToken(authRes.AccessToken)

	epochZero := time.Unix(0, 0).UTC().Format(time.RFC3339Nano)
	err = s.q.UpdateUserServerUrl(ctx, dbgen.UpdateUserServerUrlParams{
		ServerUrl:    sql.NullString{String: serverURL, Valid: true},
		LastSyncTime: sql.NullString{String: epochZero, Valid: true},
		ID:           user.ID,
	})
	if err != nil {
		return err
	}

	go func() {
		debug.FreeOSMemory()
	}()

	return nil
}

func (s *AuthService) WipeData(ctx context.Context) error {
	// 先断开所有 SSH 会话和端口转发，确保擦除数据后无活跃远程连接
	if s.sshDisconn != nil {
		s.sshDisconn.DisconnectAll()
	}

	// 使用事务确保完全清除，避免出现 blob 已删但用户还在的半清除状态
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	qtx := s.q.WithTx(tx)
	if err := qtx.WipeBlobs(ctx); err != nil {
		return err
	}
	if err := qtx.WipeUsers(ctx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}

	s.vault.Lock()
	s.client.ClearToken()

	return nil
}

func (s *AuthService) LockVault() {
	s.vault.Lock()
	s.client.ClearToken()
}

// DisconnectCloud removes the cloud server association from the local vault.
// The vault stays unlocked and all data remains; only the server URL is
// cleared and the auth token discarded. Auto-sync should be stopped by the
// caller (SyncService.StopAutoSync) before invoking this.
func (s *AuthService) DisconnectCloud(ctx context.Context) error {
	user, err := s.q.GetUser(ctx)
	if err != nil {
		return err
	}

	err = s.q.UpdateUserServerUrl(ctx, dbgen.UpdateUserServerUrlParams{
		ServerUrl:    sql.NullString{Valid: false},
		LastSyncTime: sql.NullString{Valid: false},
		ID:           user.ID,
	})
	if err != nil {
		return err
	}

	s.client.ClearToken()
	return nil
}

func (s *AuthService) GetCurrentUser(ctx context.Context) (*UserInfo, error) {
	user, err := s.q.GetUser(ctx)
	if err != nil {
		return nil, err
	}

	url := ""
	if user.ServerUrl.Valid {
		url = user.ServerUrl.String
	}

	return &UserInfo{
		Username:  user.Username,
		ServerURL: url,
	}, nil
}
