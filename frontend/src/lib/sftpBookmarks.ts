// SFTP 目录书签：按主机（会话）保存常用目录，纯前端 localStorage 持久化。
//
// 书签属于界面偏好而非需要加密的业务数据，与工作区快照、快捷键配置一致
// 放在 localStorage，简单且不触发数据库迁移。
// 注意：读取时必须逐项校验，旧版本或手工改坏的 JSON 不能让整个书签列表失效。

export interface SftpBookmark {
    /** 书签自身 ID（删除/改名用） */
    id: string;
    /** 所属主机作用域：优先 hostId，缺失时用 user@host:port */
    scope: string;
    /** 远端绝对路径 */
    path: string;
    /** 展示名称，默认取路径最后一段 */
    label: string;
}

const STORAGE_KEY = "terminator.sftp.bookmarks";
/** 全局条数上限：书签是快捷入口，过多反而难找 */
const MAX_BOOKMARKS = 120;
/** 单个主机保留的条数上限 */
const MAX_PER_SCOPE = 30;

function isBookmark(value: unknown): value is SftpBookmark {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<SftpBookmark>;
    return typeof item.id === "string" && item.id.length > 0
        && typeof item.scope === "string" && item.scope.length > 0
        && typeof item.path === "string" && item.path.length > 0
        && typeof item.label === "string";
}

function readAll(): SftpBookmark[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isBookmark);
    } catch {
        // 解析失败视为没有书签，不阻塞文件面板
        return [];
    }
}

function writeAll(list: SftpBookmark[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_BOOKMARKS)));
    } catch {
        // 存储写满或不可用时静默失败：书签只是便捷功能
    }
}

/** 取某主机下的书签列表（按添加顺序，最新在前） */
export function loadBookmarks(scope: string): SftpBookmark[] {
    return readAll().filter((item) => item.scope === scope);
}

/** 路径最后一段作为默认展示名；根目录显示 "/" */
export function bookmarkLabelFor(path: string): string {
    const parts = path.split("/").filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : "/";
}

/**
 * 添加书签。同一主机下同路径已存在时不重复添加，只更新展示名。
 * 返回该主机最新的书签列表。
 */
export function addBookmark(scope: string, path: string, label?: string): SftpBookmark[] {
    const cleanPath = path.trim();
    if (!scope || !cleanPath) return loadBookmarks(scope);
    const name = (label ?? "").trim() || bookmarkLabelFor(cleanPath);

    const all = readAll();
    const existing = all.find((item) => item.scope === scope && item.path === cleanPath);
    if (existing) {
        existing.label = name;
        writeAll(all);
        return loadBookmarks(scope);
    }

    const next: SftpBookmark = {
        id: typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        scope,
        path: cleanPath,
        label: name,
    };
    const list = [next, ...all];
    // 同一主机的旧书签超过上限时丢弃最旧的
    let scopeCount = 0;
    writeAll(list.filter((item) => {
        if (item.scope !== scope) return true;
        scopeCount++;
        return scopeCount <= MAX_PER_SCOPE;
    }));
    return loadBookmarks(scope);
}

/** 删除书签，返回该主机最新的书签列表 */
export function removeBookmark(scope: string, id: string): SftpBookmark[] {
    writeAll(readAll().filter((item) => item.id !== id));
    return loadBookmarks(scope);
}

/** 判断某路径是否已收藏 */
export function isBookmarked(bookmarks: SftpBookmark[], path: string): boolean {
    return bookmarks.some((item) => item.path === path);
}
