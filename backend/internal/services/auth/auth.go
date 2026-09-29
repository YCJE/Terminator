package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"runtime/debug"
	"sync"
	"time"
	"unicode/utf8"

	"terminator-desktop/backend/internal/api"
	"terminator-desktop/backend/internal/apperror"
	"terminator-desktop/backend/internal/crypto"
	"terminator-desktop/backend/internal/dbgen"
	"terminator-desktop/backend/internal/timeutil"
	"terminator-desktop/backend/internal/vault"

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

	// 登录失败退避状态：Argon2id 已让单次尝试变慢，此处再叠加应用层退避，
	// 抬高通过 UI 反复试错的成本
	loginMu         sync.Mutex
	loginFailures   int
	loginLockedTill time.Time
}

type UserInfo struct {
	Username  string `json:"username"`
	ServerURL string `json:"serverUrl"`
}

const (
	saltLength = 16
	keyLength  = 32

	// 登录退避参数：前 loginMaxFreeAttempts 次失败不延迟，之后按 2s、4s、8s…
	// 指数增长，上限 loginMaxBackoff。计数在成功登录后清零。
	loginMaxFreeAttempts = 5
	loginBaseBackoff     = 2 * time.Second
	loginMaxBackoff      = 5 * time.Minute
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

// validatePasswordLength 按字符数校验口令长度。
//
// 必须按 rune 而非 byte 计数：4 个汉字即 12 字节，按字节判断会错误地
// 放过远低于下限的口令。
func validatePasswordLength(password string) error {
	if utf8.RuneCountInString(password) < 6 {
		return apperror.Validation("password must be at least 6 characters")
	}
	return nil
}

func (s *AuthService) RegisterLocal(ctx context.Context, username, password string) error {
	if err := validatePasswordLength(password); err != nil {
		return err
	}

	// 防御性检查：防止通过 Wails binding 直接调用绕过 UI 守卫创建重复用户
	exists, err := s.HasUser(ctx)
	if err != nil {
		// 不能吞掉错误：查询失败时若按"不存在"继续，会插入第二个用户行，
		// 而 GetUser 取的是 LIMIT 1，可能导致原用户永久无法解锁
		return err
	}
	if exists {
		return apperror.Validation("user already exists")
	}

	masterKey := make([]byte, keyLength)
	if _, err := rand.Read(masterKey); err != nil {
		return err
	}
	// defer 确保无论成功或失败都清零 masterKey（覆盖所有后续错误路径）
	defer func() {
		for i := range masterKey {
			masterKey[i] = 0
		}
	}()

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

// loginThrottleRemaining 返回距离下次允许尝试的剩余时间；未处于锁定期时返回 0。
func (s *AuthService) loginThrottleRemaining() time.Duration {
	s.loginMu.Lock()
	defer s.loginMu.Unlock()

	if s.loginLockedTill.IsZero() {
		return 0
	}
	if remaining := time.Until(s.loginLockedTill); remaining > 0 {
		return remaining
	}
	// 锁定期已结束：清零计数，重新开始计数
	s.loginLockedTill = time.Time{}
	s.loginFailures = 0
	return 0
}

// recordLoginFailure 记录一次口令错误，超过免费次数后按指数退避设置锁定期。
func (s *AuthService) recordLoginFailure() {
	s.loginMu.Lock()
	defer s.loginMu.Unlock()

	s.loginFailures++
	if s.loginFailures <= loginMaxFreeAttempts {
		return
	}

	// 位移量先夹取，避免失败次数很大时溢出成负数
	shift := s.loginFailures - loginMaxFreeAttempts - 1
	if shift > 20 {
		shift = 20
	}
	backoff := loginBaseBackoff << shift
	if backoff <= 0 || backoff > loginMaxBackoff {
		backoff = loginMaxBackoff
	}
	s.loginLockedTill = time.Now().Add(backoff)
}

func (s *AuthService) resetLoginFailures() {
	s.loginMu.Lock()
	defer s.loginMu.Unlock()
	s.loginFailures = 0
	s.loginLockedTill = time.Time{}
}

// Login - "unlock vault"
//
// 外层负责失败退避，真正的校验逻辑在 login 中。
func (s *AuthService) Login(ctx context.Context, password string) error {
	if remaining := s.loginThrottleRemaining(); remaining > 0 {
		return apperror.LoginThrottled(int(remaining.Seconds()) + 1)
	}

	err := s.login(ctx, password)
	if err == nil {
		s.resetLoginFailures()
		return nil
	}

	// 仅口令错误计入失败次数：AuthSalt 缺失等数据损坏问题重试无意义，
	// 不该把用户锁在门外
	var appErr *apperror.AppError
	if errors.As(err, &appErr) && appErr.Code == apperror.CodeDecryptionFailed {
		s.recordLoginFailure()
	}
	return err
}

func (s *AuthService) login(ctx context.Context, password string) error {
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
	if err := validatePasswordLength(password); err != nil {
		return err
	}

	// 防御性检查：防止通过 Wails binding 直接调用绕过 UI 守卫创建重复用户
	exists, err := s.HasUser(ctx)
	if err != nil {
		// 同上：查询失败时不能按"不存在"继续，否则可能插入第二个用户行
		return err
	}
	if exists {
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

	epochZero := timeutil.Epoch()
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

	epochZero := timeutil.Epoch()
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
	// 用 recover 保护，确保即使断开失败也能继续执行数据擦除
	if s.sshDisconn != nil {
		func() {
			defer func() {
				if r := recover(); r != nil {
					// 记录但继续执行 wipe
				}
			}()
			s.sshDisconn.DisconnectAll()
		}()
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
	// 冲突记录引用的是已加密的 blob 副本，必须与 blob 一并清除，
	// 否则残留的冲突会指向不存在的数据
	if err := qtx.WipeConflicts(ctx); err != nil {
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
