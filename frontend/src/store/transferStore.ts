// 文件传输队列状态管理
// 优化：进度更新节流，避免高频事件导致 React 狂暴重渲染
// 使用尾帧刷新机制确保最后一次进度更新不丢失

import { create } from "zustand";

/** 单个传输任务 */
export interface TransferItem {
    id: string;
    sessionId: string;
    filename: string;
    type: "upload" | "download";
    transferred: number;
    total: number;
    status: "active" | "success" | "error";
    error?: string;
}

interface TransferState {
    transfers: TransferItem[];
    addTransfer: (item: TransferItem) => void;
    updateTransfer: (id: string, updates: Partial<TransferItem>) => void;
    removeTransfer: (id: string) => void;
    clearCompleted: () => void;
    removeTransfersBySession: (sessionId: string) => void;
    clearAll: () => void;
}

// 进度节流：同一 transferID 的进度事件最多每 200ms 更新一次 UI
// 使用 pending ref 暂存被节流的最新值，定时器补发最后一帧
const progressThrottle = new Map<string, number>();
const pendingUpdates = new Map<string, Partial<TransferItem>>();
const THROTTLE_MS = 200;

// 尾帧刷新定时器：每 200ms 检查是否有被节流的更新需要补发
let flushTimer: ReturnType<typeof setInterval> | null = null;

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
                return u ? { ...t, ...u } : t;
            }),
        }));
    }, THROTTLE_MS);
}

export const useTransferStore = create<TransferState>((set, get) => ({
    transfers: [],

    addTransfer: (item) => {
        progressThrottle.delete(item.id);
        pendingUpdates.delete(item.id);
        set((state) => ({
            transfers: [...state.transfers, item],
        }));
    },

    updateTransfer: (id, updates) => {
        // 完成或错误事件立即处理，不节流
        if (updates.status === "success" || updates.status === "error") {
            progressThrottle.delete(id);
            pendingUpdates.delete(id);
            set((state) => ({
                transfers: state.transfers.map((t) => (t.id === id ? { ...t, ...updates } : t)),
            }));
            return;
        }

        // 进度更新节流
        const now = Date.now();
        const lastTime = progressThrottle.get(id) ?? 0;
        if (now - lastTime < THROTTLE_MS) {
            // 暂存到 pending，等待尾帧刷新补发
            pendingUpdates.set(id, updates);
            ensureFlushTimer(set);
            return;
        }
        progressThrottle.set(id, now);
        // 清除过时的 pending，防止 flush 定时器用旧值覆盖即时更新
        pendingUpdates.delete(id);
        set((state) => ({
            transfers: state.transfers.map((t) => (t.id === id ? { ...t, ...updates } : t)),
        }));
    },

    removeTransfer: (id) => {
        progressThrottle.delete(id);
        pendingUpdates.delete(id);
        set((state) => ({
            transfers: state.transfers.filter((t) => t.id !== id),
        }));
    },

    clearCompleted: () => set((state) => ({
        transfers: state.transfers.filter((t) => t.status === "active"),
    })),

    // 清理指定会话的所有传输任务（会话断开/移除时调用）
    removeTransfersBySession: (sessionId) => {
        // 使用函数形式 set 避免过期快照竞态：如果在此期间 flushTimer 更新了其他传输进度，
        // 对象形式 set 会覆盖那些更新；函数形式则基于最新 state 计算
        const toRemove = get().transfers.filter((t) => t.sessionId === sessionId);
        for (const t of toRemove) {
            progressThrottle.delete(t.id);
            pendingUpdates.delete(t.id);
        }
        set((state) => ({transfers: state.transfers.filter((t) => t.sessionId !== sessionId)}));
    },

    // 清空所有传输任务
    clearAll: () => {
        progressThrottle.clear();
        pendingUpdates.clear();
        if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
        set({transfers: []});
    },
}));
