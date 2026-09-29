package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"terminator-desktop/backend/internal/apperror"

	"golang.org/x/crypto/argon2"
)

const (
	aesGcmIvLength = 12
	aesGcmTagSize  = 16

	// cryptoVersion1 是当前打包格式的版本号，位于 blob 首字节。
	// 旧客户端不写版本号（首字节即 IV），见 UnpackAndDecrypt 的兼容逻辑。
	cryptoVersion1 byte = 0x01

	// argon is hardcoded because this must match android app settings
	argonTimeCost   = 3
	argonMemoryCost = 128 * 1024 // 128MB
	argonThreads    = 4
	argonKeyLength  = 32
)

func deriveArgon2id(password, saltBase64 string) ([]byte, error) {
	salt, err := base64.StdEncoding.DecodeString(saltBase64)
	if err != nil {
		return nil, err
	}
	// 校验 salt 最小长度（Argon2 规范建议至少 8 字节）
	if len(salt) < 8 {
		return nil, fmt.Errorf("salt too short: %d bytes (minimum 8)", len(salt))
	}

	key := argon2.IDKey([]byte(password), salt, argonTimeCost, argonMemoryCost, argonThreads, argonKeyLength)
	return key, nil
}

func DeriveKEK(password string, keySaltBase64 string) ([]byte, error) {
	return deriveArgon2id(password, keySaltBase64)
}

func DeriveLoginKey(password, authSaltBase64 string) ([]byte, error) {
	return deriveArgon2id(password, authSaltBase64)
}

// EncryptAndPack
// input -> [IV (12) + ciphertext (N) + tag (16)] -> base64
func EncryptAndPack(plaintext []byte, key []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}

	aesGcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	iv := make([]byte, aesGcmIvLength)
	if _, err = io.ReadFull(rand.Reader, iv); err != nil {
		return "", err
	}

	versionByte := []byte{cryptoVersion1}

	payload := append(versionByte, iv...)

	// tag is auto appended here
	packedBytes := aesGcm.Seal(payload, iv, plaintext, nil)

	return base64.StdEncoding.EncodeToString(packedBytes), nil
}

// UnpackAndDecrypt 解密由 EncryptAndPack（或旧客户端）产生的 blob。
//
// 兼容两种打包格式：
//   - v1（当前客户端写入）：[版本号 0x01][IV 12][密文][tag 16]
//   - legacy（旧客户端写入）：[IV 12][密文][tag 16]
//
// 旧客户端不含版本号，历史上已产生大量数据；若不兼容，老用户的保险库数据
// （主机/密钥/密码）、主密钥以及跨端同步数据将永久无法解密。
func UnpackAndDecrypt(packedBase64 string, key []byte) ([]byte, error) {
	packedBytes, err := base64.StdEncoding.DecodeString(packedBase64)
	if err != nil {
		return nil, apperror.Validation("invalid base64 blob")
	}

	if len(packedBytes) < aesGcmIvLength+aesGcmTagSize {
		return nil, apperror.Validation("blob is too short")
	}

	// 按优先级构造候选载荷。首字节为版本号时才尝试 v1 布局，
	// 否则直接按 legacy 布局解析。两种布局都尝试可避免旧客户端 IV
	// 恰好以 0x01 开头时被误判为 v1 而解密失败。
	candidates := make([][]byte, 0, 2)
	if packedBytes[0] == cryptoVersion1 && len(packedBytes) >= 1+aesGcmIvLength+aesGcmTagSize {
		candidates = append(candidates, packedBytes[1:])
	}
	candidates = append(candidates, packedBytes)

	var lastErr error
	for _, payload := range candidates {
		plaintext, err := openGCM(payload, key)
		if err == nil {
			return plaintext, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

// openGCM 按 [IV(12)][密文][tag(16)] 布局解密单个候选载荷。
func openGCM(payload, key []byte) ([]byte, error) {
	if len(payload) < aesGcmIvLength+aesGcmTagSize {
		return nil, apperror.Validation("blob is too short")
	}

	iv := payload[:aesGcmIvLength]
	ciphertextWithTag := payload[aesGcmIvLength:]

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}

	aesGcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	plaintext, err := aesGcm.Open(nil, iv, ciphertextWithTag, nil)
	if err != nil {
		return nil, apperror.DecryptionFailed(err)
	}

	return plaintext, nil
}
