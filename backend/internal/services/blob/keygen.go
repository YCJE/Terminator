package blob

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"fmt"

	"golang.org/x/crypto/ssh"
)

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
