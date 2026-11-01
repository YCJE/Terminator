package blob

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/ssh"
)

// KeyValidation 描述一次私钥解析/校验的结果。
// Encrypted 表示私钥本身带口令；Fingerprint 为 OpenSSH 风格 SHA256 指纹，
// 可用于和服务器端 authorized_keys 或运维提供的指纹对照。
type KeyValidation struct {
	Valid       bool   `json:"valid"`
	Encrypted   bool   `json:"encrypted"`
	KeyType     string `json:"keyType"`
	Fingerprint string `json:"fingerprint"`
}

// ValidateKey 校验私钥格式与口令，并返回公钥类型与指纹。
// 加密私钥必须提供正确口令；口令错误、私钥损坏或格式不支持都会返回错误，
// 调用方据此在保存前拦截，避免把无法用于连接的密钥写入保险库。
func (s *KeyService) ValidateKey(privateKey string, passphrase string) (*KeyValidation, error) {
	key := strings.TrimSpace(privateKey)
	if key == "" {
		return nil, fmt.Errorf("私钥内容为空")
	}

	signer, err := ssh.ParsePrivateKey([]byte(key))
	encrypted := false
	if err != nil {
		var missing *ssh.PassphraseMissingError
		// 部分旧格式（PEM）在无口令时返回的错误类型可能被包装，
		// errors.As 可兼容；同时只要用户提供了口令就再尝试一次。
		if errors.As(err, &missing) || passphrase != "" {
			encrypted = true
			if passphrase == "" {
				return nil, fmt.Errorf("私钥已加密，请输入口令")
			}
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(key), []byte(passphrase))
			if err != nil {
				return nil, fmt.Errorf("口令错误或私钥已损坏")
			}
		} else {
			return nil, fmt.Errorf("私钥格式无效: %v", err)
		}
	}

	pub := signer.PublicKey()
	return &KeyValidation{
		Valid:       true,
		Encrypted:   encrypted,
		KeyType:     pub.Type(),
		Fingerprint: ssh.FingerprintSHA256(pub),
	}, nil
}

// GenerateKey 生成 SSH 私钥
// keyType: "ed25519" 或 "rsa"
// rsaBits: RSA 密钥位数（2048 或 4096），Ed25519 忽略此参数
// 返回 OpenSSH 格式的私钥（PEM 编码）
func (s *KeyService) GenerateKey(keyType string, rsaBits int) (string, error) {
	if keyType == "" {
		keyType = "ed25519"
	}

	switch keyType {
	case "ed25519":
		return s.generateEd25519Key()
	case "rsa":
		if rsaBits != 2048 && rsaBits != 4096 {
			rsaBits = 4096
		}
		return s.generateRSAKey(rsaBits)
	default:
		return "", fmt.Errorf("不支持的密钥类型: %s（支持 ed25519, rsa）", keyType)
	}
}

// generateEd25519Key 生成 Ed25519 密钥对，返回 OpenSSH 格式私钥
func (s *KeyService) generateEd25519Key() (string, error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", fmt.Errorf("生成 Ed25519 密钥失败: %w", err)
	}

	// 使用 x/crypto/ssh 将私钥序列化为 OpenSSH 格式
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
func (s *KeyService) generateRSAKey(bits int) (string, error) {
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
