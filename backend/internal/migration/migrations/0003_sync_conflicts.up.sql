-- 同步冲突：记录两端各自修改过的同一 blob，供用户选择保留哪一端。
-- 仅保留每个 blob 最近一次检测到的冲突（blob_id 为主键）。
CREATE TABLE IF NOT EXISTS sync_conflicts (
    blob_id           TEXT PRIMARY KEY NOT NULL,
    local_blob        TEXT NOT NULL,
    remote_blob       TEXT NOT NULL,
    local_updated_at  TEXT NOT NULL,
    remote_updated_at TEXT NOT NULL,
    local_deleted     BOOLEAN NOT NULL DEFAULT 0,
    remote_deleted    BOOLEAN NOT NULL DEFAULT 0,
    detected_at       TEXT NOT NULL
);