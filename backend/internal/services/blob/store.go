package blob

import (
	"context"
	"encoding/json"
	"log/slog"
	"terminator-desktop/backend/internal/crypto"
	"terminator-desktop/backend/internal/dbgen"
	"terminator-desktop/backend/internal/vault"
	"time"

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
		UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
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

	for _, b := range blobs {
		decryptedJSON, err := crypto.UnpackAndDecrypt(b.Blob, mk)
		if err != nil {
			slog.Warn("blob decryption failed, skipping", "id", b.ID, "error", err)
			continue
		}

		var header VaultItemHeader
		err = json.Unmarshal(decryptedJSON, &header)

		if err == nil && header.Type == expectedType {
			var item T
			err = json.Unmarshal(decryptedJSON, &item)

			if err == nil {
				items = append(items, item)
			} else {
				slog.Warn("blob deserialization failed, skipping", "id", b.ID, "type", expectedType, "error", err)
			}
		} else if err != nil {
			slog.Warn("blob header deserialization failed, skipping", "id", b.ID, "error", err)
		}
	}

	return items, nil
}

func deleteItem(ctx context.Context, q *dbgen.Queries, id string) error {
	return q.SoftDeleteBlob(ctx, dbgen.SoftDeleteBlobParams{
		ID:        id,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	})
}
