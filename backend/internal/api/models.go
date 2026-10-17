package api

import (
	"encoding/json"
	"time"

	"terminator-desktop/backend/internal/timeutil"
)

// Timestamp 是同步协议中的时间戳。
//
// 统一以 timeutil 的定长格式（固定 9 位小数、UTC）序列化：Go 默认的
// RFC3339Nano 会去掉小数末尾的 0、宽度可变，而 encrypted_blobs.updated_at 等列
// 以定长文本存储并做文本比较；若线上表示宽度可变，字典序会与时间序错位，
// 导致边界记录被永久漏同步。反序列化时兼容服务端返回的可变宽度/带偏移格式。
type Timestamp time.Time

// MarshalJSON 以定长 UTC 格式输出，与本地存储口径一致。
func (t Timestamp) MarshalJSON() ([]byte, error) {
	return json.Marshal(timeutil.Format(time.Time(t)))
}

// UnmarshalJSON 宽松解析服务端返回的时间戳（RFC3339Nano，兼容无小数与带偏移）。
func (t *Timestamp) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		return err
	}
	parsed, err := timeutil.Parse(s)
	if err != nil {
		return err
	}
	*t = Timestamp(parsed)
	return nil
}

type ErrorResponse struct {
	Errors []ErrorDetail `json:"errors"`
}

type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type RegisterRequest struct {
	Username           string `json:"username"`
	AuthSalt           string `json:"authSalt"`
	KeySalt            string `json:"keySalt"`
	EncryptedMasterKey string `json:"encryptedMasterKey"`
	LoginKey           string `json:"loginKey"`
}

type LoginRequest struct {
	Username string `json:"username"`
	LoginKey string `json:"loginKey"`
}

type AuthResponse struct {
	AccessToken string `json:"accessToken"`
}

type PreflightRequest struct {
	Username string `json:"username"`
}

type PreflightResponse struct {
	AuthSalt           string `json:"authSalt"`
	KeySalt            string `json:"keySalt"`
	EncryptedMasterKey string `json:"encryptedMasterKey"`
}

type EncryptedBlob struct {
	ID        string    `json:"id"`
	UpdatedAt Timestamp `json:"updatedAt"`
	IsDeleted bool      `json:"isDeleted"`
	Blob      string    `json:"blob"`
}

type SyncRequest struct {
	Blobs        []EncryptedBlob `json:"blobs"`
	LastSyncTime Timestamp       `json:"lastSyncTime"`
}

type SyncResponse struct {
	Blobs    []EncryptedBlob `json:"blobs"`
	SyncTime Timestamp       `json:"syncTime"`
}
