// 命令草稿栏的本地历史：按目标端点（user@host:port）分别保存。
//
// 只记录通过草稿栏主动发送的命令，不拦截终端键入内容，
// 因此不会把 sudo 密码等敏感输入写进历史。

const STORAGE_KEY = "terminator_compose_history_v1";
const FREQUENCY_KEY = "terminator_compose_frequency_v1";
const MAX_PER_ENDPOINT = 50;
/** 命令频次表上限：超出时按次数保留前 300 条，避免 localStorage 无限增长 */
const MAX_FREQUENCY_ENTRIES = 500;
const PRUNE_FREQUENCY_TO = 300;

type HistoryMap = Record<string, string[]>;
type FrequencyMap = Record<string, number>;

export function composeHistoryKey(config: {
    username: string;
    host: string;
    port: number;
}): string {
    return `${config.username}@${config.host}:${config.port}`;
}

function readAll(): HistoryMap {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") return {};
        const result: HistoryMap = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!Array.isArray(value)) continue;
            const list = value.filter((v): v is string => typeof v === "string" && v.length > 0);
            if (list.length > 0) result[key] = list.slice(0, MAX_PER_ENDPOINT);
        }
        return result;
    } catch {
        return {};
    }
}

function writeAll(history: HistoryMap): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch {
        // localStorage 不可用时静默忽略
    }
}

function readFrequency(): FrequencyMap {
    try {
        const raw = localStorage.getItem(FREQUENCY_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") return {};
        const result: FrequencyMap = {};
        for (const [command, count] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof count === "number" && Number.isFinite(count) && count > 0 && command) {
                result[command] = count;
            }
        }
        return result;
    } catch {
        return {};
    }
}

/** 记录一次命令使用次数：跨端点累计，用于补全时的频次排序 */
function bumpFrequency(command: string): void {
    const frequency = readFrequency();
    frequency[command] = (frequency[command] ?? 0) + 1;
    try {
        if (Object.keys(frequency).length > MAX_FREQUENCY_ENTRIES) {
            const kept = Object.entries(frequency)
                .sort((a, b) => b[1] - a[1])
                .slice(0, PRUNE_FREQUENCY_TO);
            localStorage.setItem(FREQUENCY_KEY, JSON.stringify(Object.fromEntries(kept)));
            return;
        }
        localStorage.setItem(FREQUENCY_KEY, JSON.stringify(frequency));
    } catch {
        // localStorage 不可用时静默忽略
    }
}

/** 命令使用频次（跨端点累计），未记录过时为空对象 */
export function loadCommandFrequency(): FrequencyMap {
    return readFrequency();
}

export function loadComposeHistory(key: string | null): string[] {
    if (!key) return [];
    return readAll()[key] ?? [];
}

/**
 * 跨端点合并最近命令。
 * 各端点各自保存历史，这里按"每端点最新一条"交错合并并去重，
 * 让来自多台服务器的命令都能进入前列，而不是只有当前端点可见。
 */
export function loadAllComposeHistory(limit = 30): string[] {
    const map = readAll();
    const endpoints = Object.keys(map);
    const result: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; result.length < limit; index++) {
        let advanced = false;
        for (const endpoint of endpoints) {
            const item = map[endpoint]?.[index];
            if (item === undefined) continue;
            advanced = true;
            if (seen.has(item)) continue;
            seen.add(item);
            result.push(item);
            if (result.length >= limit) return result;
        }
        if (!advanced) break;
    }
    return result;
}

/** 追加一条历史并返回更新后的列表（最新的在最前）。 */
export function pushComposeHistory(key: string, command: string): string[] {
    const history = readAll();
    const list = (history[key] ?? []).filter((item) => item !== command);
    list.unshift(command);
    if (list.length > MAX_PER_ENDPOINT) list.length = MAX_PER_ENDPOINT;
    history[key] = list;
    writeAll(history);
    bumpFrequency(command);
    return list;
}

export function clearComposeHistory(key: string): void {
    const history = readAll();
    delete history[key];
    writeAll(history);
}
