// 远端 shell 历史：连接成功后读取 ~/.bash_history、~/.zsh_history 等文件，
// 作为终端命令行补全的额外数据源。
//
// 只在内存缓存（按会话 ID），不落 localStorage：这些命令来自远端主机，
// 缓存跨会话复用没有意义，退出应用后重新读取即可。

import { SftpService } from "../../bindings/terminator-desktop/backend/internal/services/sftp";
import { joinRemotePath } from "./remotePath";

/** 最多保留的历史命令条数（各文件合并后） */
const MAX_REMOTE_HISTORY_LINES = 2000;
/** 单个历史文件最多读取的尾部字节数：历史文件可能很大，只取最近一段 */
const MAX_HISTORY_FILE_BYTES = 512 * 1024;
/** 候选历史文件：按常见程度排序，命中多个时合并去重 */
const HISTORY_FILES = [".bash_history", ".zsh_history", ".sh_history"];

const cache = new Map<string, string[]>();
interface PendingLoad {
    promise: Promise<void>;
    generation: number;
}
const pending = new Map<string, PendingLoad>();

// 每个会话一个代次：清理/重连时递增，旧任务完成后不允许再写入缓存，
// 否则上一轮连接读到的历史会在新连接里"复活"。
const generations = new Map<string, number>();

function generationOf(sessionId: string): number {
    return generations.get(sessionId) ?? 0;
}

/**
 * 解析 shell 历史文件内容，返回"最新在前"的命令列表。
 * 兼容 bash 的 "#时间戳" 行与 zsh 的扩展历史前缀 ": 时间:耗时;"。
 */
export function parseShellHistory(text: string): string[] {
    const commands: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        let line = rawLine;
        if (!line) continue;
        // 续行与 zsh 转义换行记录无法安全还原为单行命令，直接跳过
        if (line.endsWith("\\") || line.includes("\\n")) continue;
        // zsh 扩展历史：": 1690000000:0;ls -la"
        const zshMatch = /^: \d+:\d+;(.*)$/.exec(line);
        if (zshMatch) line = zshMatch[1];
        // bash 的 HISTTIMEFORMAT 时间戳单独占一行
        if (/^\s*#\d+\s*$/.test(line)) continue;
        if (line.startsWith("#")) continue;
        const trimmed = line.trim();
        if (!trimmed) continue;
        commands.push(trimmed);
    }
    return commands.slice(-MAX_REMOTE_HISTORY_LINES).reverse();
}

/** 读取已缓存的远端历史（最新在前）；未加载时返回空数组 */
export function getRemoteHistory(sessionId?: string | null): string[] {
    if (!sessionId) return [];
    return cache.get(sessionId) ?? [];
}

/** 会话关闭/重连时清理缓存 */
export function clearRemoteHistory(sessionId: string): void {
    cache.delete(sessionId);
    pending.delete(sessionId);
    // 递增代次：仍在途的读取任务完成后会发现自己已过期，直接丢弃结果
    generations.set(sessionId, generationOf(sessionId) + 1);
}

/**
 * 读取指定会话的远端 shell 历史并写入缓存。
 * 幂等：同一会话并发调用共享同一个请求；读取失败不抛出，避免影响终端连接。
 */
export function loadRemoteShellHistory(sessionId: string): Promise<void> {
    const existing = pending.get(sessionId);
    if (existing) return existing.promise;

    const generation = generationOf(sessionId);
    const task = (async () => {
        let home = "";
        try {
            home = (await SftpService.HomeDir(sessionId)) ?? "";
        } catch {
            return;
        }
        if (!home) return;

        const merged: string[] = [];
        const seen = new Set<string>();
        for (const name of HISTORY_FILES) {
            const remotePath = joinRemotePath(home, name);
            try {
                if (!(await SftpService.Exists(sessionId, remotePath))) continue;
                const text = await SftpService.ReadFileTail(sessionId, remotePath, MAX_HISTORY_FILE_BYTES);
                if (!text) continue;
                for (const command of parseShellHistory(text)) {
                    if (seen.has(command)) continue;
                    seen.add(command);
                    merged.push(command);
                    if (merged.length >= MAX_REMOTE_HISTORY_LINES) break;
                }
            } catch {
                // 单个历史文件不存在/无权限/读取失败都不影响其它候选文件
            }
            if (merged.length >= MAX_REMOTE_HISTORY_LINES) break;
        }
        // 读取期间会话可能已重连/关闭：代次变化说明结果属于上一轮连接
        if (generationOf(sessionId) !== generation) return;
        cache.set(sessionId, merged);
    })();
    const entry: PendingLoad = {promise: task, generation};
    pending.set(sessionId, entry);
    // 用 then(cleanup, cleanup) 而不是 finally：避免派生出的 Promise 在任务
    // 失败时产生未处理的 rejection（错误已经通过返回的 task 交给调用方）。
    task.then(
        () => {
            if (pending.get(sessionId) === entry) pending.delete(sessionId);
        },
        () => {
            if (pending.get(sessionId) === entry) pending.delete(sessionId);
        },
    );
    return task;
}
