// 命令面板的使用频次（仅本地）：高频项在模糊匹配分数相近时优先展示。
// 只记录条目 key，不保存命令内容或凭据；可随时通过清除站点数据删除。

const STORAGE_KEY = "terminator_palette_usage_v1";
const MAX_ENTRIES = 400;

export type PaletteUsageMap = Record<string, number>;

type UsageMap = PaletteUsageMap;

function readAll(): UsageMap {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") return {};
        const result: UsageMap = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof value === "number" && Number.isFinite(value) && value > 0) {
                result[key] = value;
            }
        }
        return result;
    } catch {
        return {};
    }
}

function writeAll(usage: UsageMap): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(usage));
    } catch {
        // localStorage 不可用时静默忽略
    }
}

/** 一次读取全部计数，供命令面板在打开时缓存，避免每次筛选重复解析 JSON。 */
export function loadPaletteUsage(): UsageMap {
    return readAll();
}

/** 记录一次选中，返回最新计数。 */
export function bumpPaletteUsage(key: string): number {
    if (!key) return 0;
    const usage = readAll();
    const next = Math.min((usage[key] ?? 0) + 1, 9999);
    usage[key] = next;
    const keys = Object.keys(usage);
    if (keys.length > MAX_ENTRIES) {
        // 超出上限时丢掉计数最低的条目，避免长期使用后无限增长
        keys.sort((a, b) => usage[a] - usage[b]);
        for (const stale of keys.slice(0, keys.length - MAX_ENTRIES)) {
            delete usage[stale];
        }
    }
    writeAll(usage);
    return next;
}

/** 把任意字符串（如最近命令）折叠成短 key，避免 localStorage 存整段命令。 */
export function hashPaletteKey(value: string): string {
    let hash = 5381;
    for (let i = 0; i < value.length; i++) {
        hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
    }
    return `h${(hash >>> 0).toString(36)}`;
}
