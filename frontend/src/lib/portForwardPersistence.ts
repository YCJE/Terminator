// 端口转发配置持久化：按主机（scope）保存转发规格，重连/重启后自动恢复。
//
// 转发配置不是敏感数据（只有地址与端口），与工作区快照、快捷键一样存于
// localStorage。运行时条目在 store 里还有一层运行时 id：后端按 id 维护监听器，
// 同一主机多会话时不能复用同一个 id，因此持久化 id 与运行时 id 分开记录。

export interface StoredForward {
    /** 持久化稳定 ID（去重、删除用） */
    id: string;
    /** 主机作用域：优先 hostId，缺失时用 user@host:port */
    scope: string;
    /** 最近一次所属会话标题，仅用于恢复前的列表展示 */
    sessionTitle: string;
    type: "local" | "remote";
    localHost: string;
    localPort: number;
    remoteHost: string;
    remotePort: number;
}

const STORAGE_KEY = "terminator.portForwards";
const MAX_FORWARDS = 100;

function isValidPort(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isStoredForward(value: unknown): value is StoredForward {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<StoredForward>;
    return typeof item.id === "string" && item.id.length > 0
        && typeof item.scope === "string" && item.scope.length > 0
        && (item.type === "local" || item.type === "remote")
        && typeof item.localHost === "string"
        && isValidPort(item.localPort)
        && typeof item.remoteHost === "string"
        && isValidPort(item.remotePort);
}

/** 主机作用域：优先 hostId，缺失时退化为 user@host:port（快速连接等场景） */
export function forwardScope(session: {
    hostId?: string;
    config: { username: string; host: string; port: number };
}): string {
    if (session.hostId) return session.hostId;
    return `${session.config.username}@${session.config.host}:${session.config.port}`;
}

export function loadStoredForwards(): StoredForward[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isStoredForward).slice(0, MAX_FORWARDS);
    } catch {
        // 解析失败视为没有持久化转发，不影响新建转发
        return [];
    }
}

function writeStored(list: StoredForward[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_FORWARDS)));
    } catch {
        // 存储不可用（配额满/隐私模式）时静默失败：不影响当前会话内的转发
    }
}

/** 同一主机下"类型 + 四个地址端口"即视为同一条转发，避免重复恢复 */
function sameTarget(a: StoredForward, b: StoredForward): boolean {
    return a.type === b.type
        && a.localHost === b.localHost && a.localPort === b.localPort
        && a.remoteHost === b.remoteHost && a.remotePort === b.remotePort;
}

/** 新增或更新一条持久化转发（同主机同目标已存在时沿用原 ID） */
export function upsertStoredForward(record: StoredForward): StoredForward {
    const list = loadStoredForwards();
    const existing = list.find((item) => item.scope === record.scope && sameTarget(item, record));
    if (existing) {
        existing.sessionTitle = record.sessionTitle || existing.sessionTitle;
        writeStored(list);
        return existing;
    }
    // 超过上限时丢弃最早的一条，保证新配置一定被写入
    const next = list.length >= MAX_FORWARDS ? [...list.slice(1), record] : [...list, record];
    writeStored(next);
    return record;
}

export function removeStoredForward(id: string): void {
    writeStored(loadStoredForwards().filter((item) => item.id !== id));
}

export function clearStoredForwards(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        // 静默失败：下次启动会重新读取到旧值，但不影响当前运行
    }
}

// ---- 自动恢复的尝试状态 ----
// 恢复由"会话连上"触发，而 store 更新也会触发同一段逻辑。
// 用模块级 Map 记住已尝试过的（会话, 配置）组合，避免失败后反复重试刷提示；
// 会话断开时清空，使下一次重连仍会尝试恢复。

const restoreAttempts = new Map<string, "pending" | "failed">();

function attemptKey(sessionId: string, storedId: string): string {
    return `${sessionId}\n${storedId}`;
}

/** 开始一次恢复尝试；已经尝试过时返回其状态（null 表示可以尝试） */
export function beginRestoreAttempt(sessionId: string, storedId: string): "pending" | "failed" | null {
    const key = attemptKey(sessionId, storedId);
    const previous = restoreAttempts.get(key);
    if (previous) return previous;
    restoreAttempts.set(key, "pending");
    return null;
}

/** 记录恢复结果：成功则清除记录，失败保留标记以阻止重复重试 */
export function finishRestoreAttempt(sessionId: string, storedId: string, success: boolean): void {
    const key = attemptKey(sessionId, storedId);
    if (success) restoreAttempts.delete(key);
    else restoreAttempts.set(key, "failed");
}

/** 会话断开时清空该会话的尝试记录，使重连后可以重新恢复 */
export function resetRestoreAttempts(sessionId: string): void {
    const prefix = `${sessionId}\n`;
    for (const key of restoreAttempts.keys()) {
        if (key.startsWith(prefix)) restoreAttempts.delete(key);
    }
}
