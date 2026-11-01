// 文件传输队列状态管理
// 优化：进度更新节流，避免高频事件导致 React 狂暴重渲染
// 使用尾帧刷新机制确保最后一次进度更新不丢失
//
// 队列语义：
// - queued    已入队、等待并发槽位（尚未调用后端）
// - active    正在传输
// - pausing   已请求暂停，等待后端真正停下（此时不能续传，避免取消请求
//             误伤刚续传的新任务）
// - paused    后端已停止，临时文件保留，可续传
// - success   成功
// - error     失败（用户主动取消时 cancelled=true）

import { create } from "zustand";

export type TransferStatus = "queued" | "active" | "pausing" | "paused" | "success" | "error";

/** 传输类型：上传 / 下载 / 跨服务器复制（远端 → 远端） */
export type TransferType = "upload" | "download" | "copy";

/** 单个传输任务 */
export interface TransferItem {
    id: string;
    sessionId: string;
    filename: string;
    type: TransferType;
    transferred: number;
    total: number;
    status: TransferStatus;
    error?: string;
    /** 用户主动取消：界面显示"已取消"并忽略后端返回的取消错误文案 */
    cancelled?: boolean;
    /** 传输的本地路径，失败/暂停后重试或续传用 */
    localPath?: string;
    /** 传输的远端路径，失败/暂停后重试或续传用；type=copy 时为目标端路径 */
    remotePath?: string;
    /** 跨服务器复制：目标会话 ID（type=copy 时必填） */
    targetSessionId?: string;
    /** 跨服务器复制：源端路径（type=copy 时必填） */
    sourcePath?: string;
    /** 打包下载的远端源路径列表（有值时走 DownloadArchive 而非单文件下载） */
    archivePaths?: string[];
    /**
     * 压缩上传标记：localPath 是本地目录、remotePath 是目标目录。
     * 重试时必须走 UploadDirArchive；按普通 Upload 递归上传会把目录内容
     * 平铺到目标目录，而不是还原成 <目录名>/… 的结构。
     */
    archiveUpload?: boolean;
    /** 入队时间（毫秒），用于展示耗时与排序 */
    startedAt: number;
    /** 结束时间（成功/失败/取消时写入） */
    finishedAt?: number;
    /** 平滑后的瞬时速率（字节/秒），暂停时归零 */
    bytesPerSec?: number;
}

interface TransferState {
    transfers: TransferItem[];
    addTransfer: (item: Omit<TransferItem, "startedAt"> & { startedAt?: number }) => void;
    updateTransfer: (id: string, updates: Partial<TransferItem>) => void;
    /** 请求暂停：先进入 pausing，等后端完成事件后再转为 paused */
    markPausing: (id: string) => void;
    /** 续传：把 paused 条目恢复为 active（调用方随后重新发起传输） */
    resumeTransfer: (id: string) => void;
    removeTransfer: (id: string) => void;
    clearCompleted: (sessionId?: string) => void;
    removeTransfersBySession: (sessionId: string) => void;
    clearAll: () => void;
}

// 进度节流：同一 transferID 的进度事件最多每 200ms 更新一次 UI
const progressThrottle = new Map<string, number>();
const pendingUpdates = new Map<string, Partial<TransferItem>>();
const THROTTLE_MS = 200;

// 速率采样：用最近一段窗口的增量计算瞬时速度，再做指数平滑
const speedSamples = new Map<string, { at: number; bytes: number; speed: number }>();
const SPEED_WINDOW_MS = 400;

// 完成记录保留上限，避免长时间使用后队列无限增长
const MAX_TRANSFERS = 200;

// 尾帧刷新定时器：每 200ms 检查是否有被节流的更新需要补发
let flushTimer: ReturnType<typeof setInterval> | null = null;

function isTerminal(status: TransferStatus): boolean {
    return status === "success" || status === "error";
}

function isPausedLike(status: TransferStatus): boolean {
    return status === "pausing" || status === "paused";
}

function ensureFlushTimer(set: (fn: (s: TransferState) => Partial<TransferState>) => void) {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
        if (pendingUpdates.size === 0) {
            // 没有待处理的更新，自动停止定时器节省资源
            if (flushTimer) {
                clearInterval(flushTimer);
                flushTimer = null;
            }
            return;
        }
        const updates = new Map(pendingUpdates);
        pendingUpdates.clear();
        set((state) => ({
            transfers: state.transfers.map((t) => {
                const u = updates.get(t.id);
                if (!u) return t;
                // 尾帧补发不能把已完成的条目改回 active
                if (isTerminal(t.status) && !isTerminal(u.status ?? t.status)) {
                    return t;
                }
                // 暂停态只接收进度数字，不能把状态改回 active
                if (isPausedLike(t.status) && !isTerminal(u.status ?? t.status)) {
                    return {
                        ...t,
                        transferred: u.transferred ?? t.transferred,
                        total: u.total ?? t.total,
                        bytesPerSec: 0,
                    };
                }
                return {...t, ...u};
            }),
        }));
    }, THROTTLE_MS);
}

export const useTransferStore = create<TransferState>((set, get) => ({
    transfers: [],

    addTransfer: (item) => {
        const now = Date.now();
        const nextItem: TransferItem = {
            ...item,
            startedAt: item.startedAt ?? now,
            bytesPerSec: 0,
        };
        progressThrottle.delete(nextItem.id);
        pendingUpdates.delete(nextItem.id);
        speedSamples.set(nextItem.id, {
            at: now,
            bytes: nextItem.transferred,
            speed: 0,
        });
        set((state) => {
            let transfers = [...state.transfers, nextItem];
            if (transfers.length > MAX_TRANSFERS) {
                // 优先丢弃最早的终态记录，进行中/暂停中的任务始终保留
                const index = transfers.findIndex((t) => isTerminal(t.status));
                if (index >= 0) {
                    const removed = transfers[index];
                    speedSamples.delete(removed.id);
                    transfers = transfers.filter((_, i) => i !== index);
                }
            }
            return {transfers};
        });
    },

    updateTransfer: (id, updates) => {
        const current = get().transfers.find((t) => t.id === id);
        if (!current) return;
        // 已到终态的条目忽略后续进度：sftp:progress 走事件通道、promise 回调走
        // 微任务，两者顺序无保证。晚到的一帧 active 会把 success/error 改回
        // active，卡片永久转圈且删除按钮不显示。
        if (isTerminal(current.status) && !isTerminal(updates.status ?? current.status)) {
            return;
        }

        const now = Date.now();
        let next: Partial<TransferItem> = {...updates};

        // 暂停态：允许成功事件（可能刚好传完），但错误事件一律转为 paused。
        // 取消/失败只应由 active 状态进入 error；active 下用户点取消时不会先 markPausing。
        if (isPausedLike(current.status) && !isTerminal(updates.status ?? current.status)) {
            // 显式 paused 用于"暂停超时兜底"；其余进度/active 事件只能保留当前暂停态
            next.status = updates.status === "paused" ? "paused" : current.status;
            next.error = undefined;
            next.cancelled = false;
            next.bytesPerSec = 0;
        }
        if (updates.status === "error" && isPausedLike(current.status)) {
            next = {
                ...next,
                status: "paused",
                error: undefined,
                cancelled: false,
                bytesPerSec: 0,
                finishedAt: undefined,
            };
        }
        if (updates.status === "success") {
            next = {...next, status: "success", finishedAt: now, bytesPerSec: 0};
            speedSamples.delete(id);
        } else if (updates.status === "error" && !isPausedLike(current.status)) {
            next = {...next, status: "error", finishedAt: now, bytesPerSec: 0};
            speedSamples.delete(id);
        } else if (isPausedLike(next.status ?? current.status)) {
            next.bytesPerSec = 0;
        }

        // 进度速率：只在进行中更新；暂停/终态不覆盖
        const effectiveStatus = next.status ?? current.status;
        if (effectiveStatus === "active" && typeof updates.transferred === "number") {
            const sample = speedSamples.get(id) ?? {
                at: now,
                bytes: current.transferred,
                speed: 0,
            };
            const elapsed = now - sample.at;
            if (elapsed >= SPEED_WINDOW_MS) {
                const delta = Math.max(0, updates.transferred - sample.bytes);
                const instant = (delta * 1000) / elapsed;
                sample.speed = sample.speed > 0 ? sample.speed * 0.6 + instant * 0.4 : instant;
                sample.at = now;
                sample.bytes = updates.transferred;
                speedSamples.set(id, sample);
            }
            next.bytesPerSec = Math.round(sample.speed);
        }

        // 完成或状态切换立即处理，不节流
        if (next.status !== undefined && (isTerminal(next.status) || isPausedLike(next.status))) {
            progressThrottle.delete(id);
            pendingUpdates.delete(id);
            set((state) => ({
                transfers: state.transfers.map((t) => (t.id === id ? {...t, ...next} : t)),
            }));
            return;
        }

        // 纯进度更新节流
        const lastTime = progressThrottle.get(id) ?? 0;
        if (now - lastTime < THROTTLE_MS) {
            pendingUpdates.set(id, next);
            ensureFlushTimer(set);
            return;
        }
        progressThrottle.set(id, now);
        // 清除过时的 pending，防止 flush 定时器用旧值覆盖即时更新
        pendingUpdates.delete(id);
        set((state) => ({
            transfers: state.transfers.map((t) => (t.id === id ? {...t, ...next} : t)),
        }));
    },

    markPausing: (id) => {
        progressThrottle.delete(id);
        pendingUpdates.delete(id);
        set((state) => ({
            transfers: state.transfers.map((t) =>
                t.id === id && t.status === "active"
                    ? {...t, status: "pausing", bytesPerSec: 0}
                    : t
            ),
        }));
    },

    resumeTransfer: (id) => {
        const current = get().transfers.find((t) => t.id === id);
        if (!current || current.status !== "paused") return;
        progressThrottle.delete(id);
        pendingUpdates.delete(id);
        speedSamples.set(id, {at: Date.now(), bytes: current.transferred, speed: 0});
        set((state) => ({
            transfers: state.transfers.map((t) =>
                t.id === id
                    ? {
                        ...t,
                        status: "active",
                        error: undefined,
                        cancelled: false,
                        finishedAt: undefined,
                        bytesPerSec: 0,
                    }
                    : t
            ),
        }));
    },

    removeTransfer: (id) => {
        progressThrottle.delete(id);
        pendingUpdates.delete(id);
        speedSamples.delete(id);
        set((state) => ({
            transfers: state.transfers.filter((t) => t.id !== id),
        }));
    },

    clearCompleted: (sessionId) => set((state) => {
        // 一并清理被移除任务的节流表项：否则这两个模块级 Map 会随反复
        // "清空已完成"无限增长（其余移除路径都做了清理）。
        // 只清理终态：暂停中的任务仍可续传，不能被"清除已完成"误删。
        for (const t of state.transfers) {
            if (isTerminal(t.status) && (!sessionId || t.sessionId === sessionId)) {
                progressThrottle.delete(t.id);
                pendingUpdates.delete(t.id);
                speedSamples.delete(t.id);
            }
        }
        // 传入 sessionId 时只清理该会话的终态任务，进行中的与其它会话的保留
        return {
            transfers: state.transfers.filter(
                (t) => !isTerminal(t.status) || (!!sessionId && t.sessionId !== sessionId)
            ),
        };
    }),

    // 清理指定会话的所有传输任务（会话断开/移除时调用）
    removeTransfersBySession: (sessionId) => {
        // 使用函数形式 set 避免过期快照竞态：如果在此期间 flushTimer 更新了其他传输进度，
        // 对象形式 set 会覆盖那些更新；函数形式则基于最新 state 计算
        const toRemove = get().transfers.filter((t) => t.sessionId === sessionId);
        for (const t of toRemove) {
            progressThrottle.delete(t.id);
            pendingUpdates.delete(t.id);
            speedSamples.delete(t.id);
        }
        set((state) => ({transfers: state.transfers.filter((t) => t.sessionId !== sessionId)}));
    },

    // 清空所有传输任务
    clearAll: () => {
        progressThrottle.clear();
        pendingUpdates.clear();
        speedSamples.clear();
        if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
        set({transfers: []});
    },
}));
