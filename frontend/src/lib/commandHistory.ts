// 命令草稿栏的本地历史：按目标端点（user@host:port）分别保存。
//
// 只记录通过草稿栏主动发送的命令，不拦截终端键入内容，
// 因此不会把 sudo 密码等敏感输入写进历史。

const STORAGE_KEY = "terminator_compose_history_v1";
const MAX_PER_ENDPOINT = 50;

type HistoryMap = Record<string, string[]>;

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

export function loadComposeHistory(key: string | null): string[] {
    if (!key) return [];
    return readAll()[key] ?? [];
}

/** 追加一条历史并返回更新后的列表（最新的在最前）。 */
export function pushComposeHistory(key: string, command: string): string[] {
    const history = readAll();
    const list = (history[key] ?? []).filter((item) => item !== command);
    list.unshift(command);
    if (list.length > MAX_PER_ENDPOINT) list.length = MAX_PER_ENDPOINT;
    history[key] = list;
    writeAll(history);
    return list;
}

export function clearComposeHistory(key: string): void {
    const history = readAll();
    delete history[key];
    writeAll(history);
}
