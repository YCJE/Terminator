-- 增量同步按 updated_at 做范围查询，添加索引避免全表扫描
CREATE INDEX IF NOT EXISTS idx_encrypted_blobs_updated_at ON encrypted_blobs (updated_at);