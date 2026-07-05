package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"terminator-desktop/backend/internal/services/settings"
	"terminator-desktop/backend/internal/webdav"

	"golang.org/x/crypto/ssh"
)

// WebDAVService 暴露给前端的 WebDAV 配置管理服务。
// WebDAV 配置存储在 settings.json（AppSettings），不存 DB。
type WebDAVService struct {
	settingsSvc *settings.SettingsService
}

// NewWebDAVService 创建 WebDAVService
func NewWebDAVService(settingsSvc *settings.SettingsService) *WebDAVService {
	return &WebDAVService{settingsSvc: settingsSvc}
}

// TestWebDAVConnection 测试 WebDAV 连接是否可用（前端调用，无需解锁 vault）
func (s *WebDAVService) TestWebDAVConnection(url, username, password string) error {
	if url == "" {
		return errors.New("WebDAV URL 不能为空")
	}
	return webdav.TestConnection(url, username, password)
}

// SaveWebDAVConfig 保存 WebDAV 配置到 settings.json，并将同步方式切换为 webdav。
// 密码明文存储在 settings.json（和网盘密码一样，用户自己负责）。
// 如果 password 为空，保留原有密码（编辑配置时不强制重新输入密码）。
func (s *WebDAVService) SaveWebDAVConfig(url, username, password string) error {
	if url == "" {
		return errors.New("WebDAV URL 不能为空")
	}

	current, err := s.settingsSvc.GetSettings()
	if err != nil {
		return err
	}

	current.SyncMethod = "webdav"
	current.WebDAVURL = url
	current.WebDAVUsername = username
	// 密码为空时保留原密码，避免编辑配置时意外清空密码
	if password != "" {
		current.WebDAVPassword = password
	}

	return s.settingsSvc.SaveSettings(current)
}

// GetWebDAVConfig 获取 WebDAV 配置，出于安全考虑不返回密码
func (s *WebDAVService) GetWebDAVConfig() (url, username string, err error) {
	current, err := s.settingsSvc.GetSettings()
	if err != nil {
		return "", "", err
	}
	return current.WebDAVURL, current.WebDAVUsername, nil
}

// LogService 暴露给前端的日志查看服务
type LogService struct {
	appDir string
}

// NewLogService 创建 LogService
func NewLogService(appDir string) *LogService {
	return &LogService{appDir: appDir}
}

// GetLogs 读取日志文件内容，返回最后 maxLines 行
func (s *LogService) GetLogs(maxLines int) (string, error) {
	if maxLines <= 0 {
		maxLines = 500
	}
	logPath := filepath.Join(s.appDir, logFileName)
	content, err := os.ReadFile(logPath)
	if err != nil {
		return "", fmt.Errorf("读取日志失败: %w", err)
	}
	lines := strings.Split(string(content), "\n")
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}
	return strings.Join(lines, "\n"), nil
}

// ClearLogs 清空日志文件
func (s *LogService) ClearLogs() error {
	logPath := filepath.Join(s.appDir, logFileName)
	return os.WriteFile(logPath, []byte{}, 0666)
}

// KeyGenService 密钥生成服务，支持生成 Ed25519 和 RSA 密钥对
type KeyGenService struct{}

// NewKeyGenService 创建 KeyGenService
func NewKeyGenService() *KeyGenService {
	return &KeyGenService{}
}

// GenerateKey 生成 SSH 私钥
// keyType: "ed25519" 或 "rsa"
// rsaBits: RSA 密钥位数（2048 或 4096），Ed25519 忽略此参数
// 返回 OpenSSH 格式的私钥（PEM 编码）
func (s *KeyGenService) GenerateKey(keyType string, rsaBits int) (string, error) {
	if keyType == "" {
		keyType = "ed25519"
	}

	switch keyType {
	case "ed25519":
		return generateEd25519Key()
	case "rsa":
		if rsaBits != 2048 && rsaBits != 4096 {
			rsaBits = 4096
		}
		return generateRSAKey(rsaBits)
	default:
		return "", fmt.Errorf("不支持的密钥类型: %s（支持 ed25519, rsa）", keyType)
	}
}

// generateEd25519Key 生成 Ed25519 密钥对，返回 OpenSSH 格式私钥
func generateEd25519Key() (string, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", fmt.Errorf("生成 Ed25519 密钥失败: %w", err)
	}

	// 使用 x/crypto/ssh 将私钥序列化为 OpenSSH 格式
	// 直接使用 MarshalPrivateKey（无密码）
	pemBlock, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		// 回退：用 PEM 编码原始私钥
		privKeyDER, err2 := x509.MarshalPKCS8PrivateKey(priv)
		if err2 != nil {
			return "", fmt.Errorf("序列化私钥失败: %w", err2)
		}
		pemBlock = &pem.Block{Type: "PRIVATE KEY", Bytes: privKeyDER}
	}
	privateKeyPEM := pem.EncodeToMemory(pemBlock)

	// 验证公钥可正确序列化（确保密钥有效）
	_, err = ssh.NewPublicKey(pub)
	if err != nil {
		return "", fmt.Errorf("公钥验证失败: %w", err)
	}

	return string(privateKeyPEM), nil
}

// generateRSAKey 生成 RSA 密钥对，返回 OpenSSH 格式私钥
func generateRSAKey(bits int) (string, error) {
	privateKey, err := rsa.GenerateKey(rand.Reader, bits)
	if err != nil {
		return "", fmt.Errorf("生成 RSA 密钥失败: %w", err)
	}

	// 使用 x/crypto/ssh 序列化为 OpenSSH 格式
	pemBlock, err := ssh.MarshalPrivateKey(privateKey, "")
	if err != nil {
		// 回退：用 PKCS1 PEM 编码
		pemBlock = &pem.Block{
			Type:  "RSA PRIVATE KEY",
			Bytes: x509.MarshalPKCS1PrivateKey(privateKey),
		}
	}
	privateKeyPEM := pem.EncodeToMemory(pemBlock)

	return string(privateKeyPEM), nil
}
