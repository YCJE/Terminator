package blob

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"terminator-desktop/backend/internal/apperror"
	"terminator-desktop/backend/internal/crypto"
	"terminator-desktop/backend/internal/dbgen"
	"terminator-desktop/backend/internal/timeutil"
	"terminator-desktop/backend/internal/vault"

	"github.com/google/uuid"
)

func saveItem[T any](ctx context.Context, q *dbgen.Queries, v *vault.Vault, id string, item T) (string, error) {
	mk, err := v.GetMasterKey()
	if err != nil {
		return "", err
	}
	defer func() {
		for i := range mk {
			mk[i] = 0
		}
	}()

	if id == "" {
		id = uuid.New().String()
	}

	jsonBytes, err := json.Marshal(item)
	if err != nil {
		return "", err
	}

	packedBlob, err := crypto.EncryptAndPack(jsonBytes, mk)
	if err != nil {
		return "", err
	}

	err = q.UpsertBlob(ctx, dbgen.UpsertBlobParams{
		ID:        id,
		Blob:      packedBlob,
		UpdatedAt: timeutil.Now(),
		IsDeleted: false,
	})
	if err != nil {
		return "", err
	}

	return id, nil
}

func getAllItems[T any](ctx context.Context, q *dbgen.Queries, v *vault.Vault, expectedType ItemType) ([]T, error) {
	mk, err := v.GetMasterKey()
	if err != nil {
		return nil, err
	}
	defer func() {
		for i := range mk {
			mk[i] = 0
		}
	}()

	blobs, err := q.GetActiveBlobs(ctx)
	if err != nil {
		return nil, err
	}

	items := make([]T, 0)
	// 解密失败计数。单条损坏可跳过，但若整库都无法解密（如主密钥与数据不匹配、
	// 密文被篡改），只返回空列表会让界面表现为"数据全部消失"却毫无提示，
	// 用户会误判为已丢失。故此处对全部失败的情形显式报错。
	decryptFailures := 0
	// 属于该类型（解密成功且类型匹配）的条目数与其中反序列化失败的条目数。
	typeMatched := 0
	typeBroken := 0

	for _, b := range blobs {
		decryptedJSON, err := crypto.UnpackAndDecrypt(b.Blob, mk)
		if err != nil {
			decryptFailures++
			slog.Warn("blob decryption failed, skipping", "id", b.ID, "error", err)
			continue
		}

		var header VaultItemHeader
		err = json.Unmarshal(decryptedJSON, &header)

		// 历史客户端写入的条目没有 type 字段：按内容特征推断类型，
		// 否则这些仍能解密的主机会在所有列表中"消失"（数据还在，但无法使用）。
		if err == nil && header.Type == "" {
			header.Type = inferLegacyType(decryptedJSON)
		}

		if err == nil && header.Type == expectedType {
			typeMatched++
			var item T
			err = json.Unmarshal(decryptedJSON, &item)

			if err == nil {
				items = append(items, item)
			} else {
				typeBroken++
				slog.Warn("blob deserialization failed, skipping", "id", b.ID, "type", expectedType, "error", err)
			}
		} else if err != nil {
			slog.Warn("blob header deserialization failed, skipping", "id", b.ID, "error", err)
		}
	}

	if len(blobs) > 0 && decryptFailures == len(blobs) {
		return nil, fmt.Errorf("全部 %d 条数据均无法解密，主密钥可能不匹配或数据已损坏", decryptFailures)
	}
	// 该类型的条目全部反序列化失败时也必须报错：只返回空列表会让用户以为
	// 数据被清空，而实际上只是解析失败（例如字段类型不兼容）。
	if typeMatched > 0 && len(items) == 0 && typeBroken == typeMatched {
		return nil, fmt.Errorf("%s 类型的 %d 条数据均无法解析，数据可能已损坏", expectedType, typeMatched)
	}

	return items, nil
}

// inferLegacyType 从缺少 type 字段的历史条目推断其类型。
//
// 早期客户端（本仓库首个提交之前）写入的 host 条目没有 type 字段，
// 但可按各自的标志性字段区分：密钥有 privateKey，片段有 command，
// 主机有 host。无法识别时返回空类型，由调用方按"类型不匹配"跳过。
func inferLegacyType(raw []byte) ItemType {
	var probe struct {
		PrivateKey *string `json:"privateKey"`
		Command    *string `json:"command"`
		Host       *string `json:"host"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return ""
	}
	switch {
	case probe.PrivateKey != nil:
		return TypeKey
	case probe.Command != nil:
		return TypeSnippet
	case probe.Host != nil:
		return TypeHost
	default:
		return ""
	}
}

func deleteItem(ctx context.Context, q *dbgen.Queries, v *vault.Vault, id string) error {
	// 检查 vault 是否解锁，与 saveItem/getAllItems 保持一致
	// 用 IsUnlocked 而非 GetMasterKey，避免不必要地获取主密钥副本
	if !v.IsUnlocked() {
		return apperror.VaultLocked()
	}
	return q.SoftDeleteBlob(ctx, dbgen.SoftDeleteBlobParams{
		ID:        id,
		UpdatedAt: timeutil.Now(),
	})
}
