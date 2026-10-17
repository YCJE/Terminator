-- name: HasUser :one
SELECT COUNT(*) FROM users;

-- name: GetUser :one
-- ORDER BY rowid：确保返回确定的一行（最早创建的账户）。
-- 原先无 ORDER BY 的 LIMIT 1 返回哪一行不确定，配合重复用户会随机取到
-- 密钥不匹配的行，导致解锁失败。
SELECT * FROM users ORDER BY rowid LIMIT 1;

-- name: CreateUser :exec
INSERT INTO users (
    id, username, key_salt, auth_salt, encrypted_master_key,
    server_url, last_sync_time
) VALUES (
    ?, ?, ?, ?, ?, ?, ?
);

-- name: UpdateUserServerUrl :exec
UPDATE users
SET server_url = ?, last_sync_time = ?
WHERE id = ?;

-- name: UpdateUserLastSyncTime :exec
UPDATE users
SET last_sync_time = ?
WHERE id = ?;

-- name: WipeUsers :exec
DELETE FROM users;


