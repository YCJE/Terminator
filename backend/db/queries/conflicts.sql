-- name: UpsertConflict :exec
INSERT INTO sync_conflicts (
    blob_id, local_blob, remote_blob, local_updated_at, remote_updated_at,
    local_deleted, remote_deleted, detected_at
) VALUES (
    ?, ?, ?, ?, ?, ?, ?, ?
)
ON CONFLICT(blob_id) DO UPDATE SET
    local_blob = excluded.local_blob,
    remote_blob = excluded.remote_blob,
    local_updated_at = excluded.local_updated_at,
    remote_updated_at = excluded.remote_updated_at,
    local_deleted = excluded.local_deleted,
    remote_deleted = excluded.remote_deleted,
    detected_at = excluded.detected_at;

-- name: ListConflicts :many
SELECT blob_id, local_blob, remote_blob, local_updated_at, remote_updated_at,
       local_deleted, remote_deleted, detected_at
FROM sync_conflicts
ORDER BY detected_at DESC;

-- name: GetConflict :one
SELECT blob_id, local_blob, remote_blob, local_updated_at, remote_updated_at,
       local_deleted, remote_deleted, detected_at
FROM sync_conflicts
WHERE blob_id = ?;

-- name: CountConflicts :one
SELECT COUNT(*) FROM sync_conflicts;

-- name: DeleteConflict :exec
DELETE FROM sync_conflicts
WHERE blob_id = ?;

-- name: WipeConflicts :exec
DELETE FROM sync_conflicts;