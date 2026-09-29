// Package timeutil 提供统一的固定宽度时间戳格式。
//
// 背景：encrypted_blobs.updated_at 与 users.last_sync_time 以 TEXT 存储，
// 增量同步通过 SQL 的 `updated_at > ?` 做文本比较。Go 的 time.RFC3339Nano
// 会去掉小数末尾的 0（宽度可变），例如 ".1Z" 与 ".12Z"，其字典序与时间先后
// 并不一致（".12Z" < ".1Z"），会导致比 last_sync_time 更新的记录被漏掉，
// 造成该条数据永久无法同步。
//
// 因此所有写入这些列的时间戳统一使用 9 位定长小数，保证字典序 == 时间序。
package timeutil

import "time"

// Layout 是定长的 RFC3339 布局（固定 9 位小数，UTC）。
const Layout = "2006-01-02T15:04:05.000000000Z07:00"

// epoch 是增量同步的时间下界，表示"从未同步过"。
const epoch = "1970-01-01T00:00:00.000000000Z"

// Format 将时间格式化为定长字符串（UTC）。
func Format(t time.Time) string {
	return t.UTC().Format(Layout)
}

// Now 返回当前时间的定长字符串（UTC）。
func Now() string {
	return Format(time.Now())
}

// Epoch 返回增量同步的时间下界字符串。
func Epoch() string {
	return epoch
}

// syncMargin 增量同步查询的时间回退量。
//
// 历史版本写入的时间戳为可变宽度（time.RFC3339Nano 会去掉小数末尾的 0），
// 与定长格式混用做文本比较时，同一秒内的值可能被误判为"更旧"而漏查。
// 例如 last_sync_time 为旧格式 ".5Z"、新记录为定长 ".500000000Z" 时，
// 文本比较会认为新记录更小（'0' < 'Z'），导致该记录永久无法上传。
//
// 查询时统一下界回退该余量，使边界附近的数据被保守地重新纳入。
// 重复上传是幂等的 upsert，不会产生副作用。
const syncMargin = 2 * time.Second

// Parse 解析 RFC3339 时间字符串，同时兼容定长与可变宽度（含无小数部分）格式。
func Parse(s string) (time.Time, error) {
	return time.Parse(time.RFC3339Nano, s)
}

// SinceBound 根据上次同步时间计算增量查询下界（定长字符串）。
// 为空或无法解析时返回 Epoch（退化为全量同步），避免因单条脏数据导致同步永久失败。
func SinceBound(lastSync string) string {
	if lastSync == "" {
		return epoch
	}
	t, err := Parse(lastSync)
	if err != nil {
		return epoch
	}
	return Format(t.Add(-syncMargin))
}
