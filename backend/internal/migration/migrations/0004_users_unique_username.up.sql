-- username 唯一约束。
--
-- 背景：注册/登录的「先 HasUser 查询、再 CreateUser 插入」是 TOCTOU，
-- 且 users.username 原先没有唯一约束，两个并发注册（Wails 每个绑定调用
-- 独立 goroutine，LoginFromSync 的窗口还横跨网络请求）可写入两行 users；
-- 而 GetUser 用 LIMIT 1 且无 ORDER BY，取到哪一行不确定，一旦取到密钥
-- 不匹配的行，用户将被永久锁在门外。
--
-- 先清理历史可能存在的重复行（保留最早创建的一行），避免在既有重复数据
-- 的库上建唯一索引失败导致迁移中断；再建立唯一索引作为并发插入的兜底。
DELETE FROM users
WHERE rowid NOT IN (SELECT MIN(rowid) FROM users GROUP BY username);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
