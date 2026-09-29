-- name: GetActiveBlobs :many
SELECT * FROM encrypted_blobs
WHERE is_deleted = 0;

-- name: GetBlobsSince :many
SELECT * FROM encrypted_blobs
WHERE updated_at > ?;

-- name: GetAllBlobs :many
-- 备份导出需要完整快照，包含已软删除的行：墓碑记录必须一并导出，
-- 否则恢复后被删除的条目会被其他设备上的旧副本重新同步回来。
SELECT * FROM encrypted_blobs;

-- name: UpsertBlob :exec
INSERT INTO encrypted_blobs (
    id, blob, updated_at, is_deleted
) VALUES (
    ?, ?, ?, ?
)
ON CONFLICT(id) DO UPDATE SET
    blob = excluded.blob,
    updated_at = excluded.updated_at,
    is_deleted = excluded.is_deleted;

-- name: UpsertBlobIfNewer :exec
INSERT INTO encrypted_blobs (
    id, blob, updated_at, is_deleted
) VALUES (
    ?, ?, ?, ?
)
ON CONFLICT(id) DO UPDATE SET
    blob = excluded.blob,
    updated_at = excluded.updated_at,
    is_deleted = excluded.is_deleted
WHERE excluded.updated_at > encrypted_blobs.updated_at;

-- name: SoftDeleteBlob :exec
UPDATE encrypted_blobs
SET is_deleted = 1, updated_at = ?
WHERE id = ?;

-- name: WipeBlobs :exec
DELETE FROM encrypted_blobs;