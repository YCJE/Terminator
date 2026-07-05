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
}

// 进度节流：同一 transferID 的进度事件最多每 200ms 更新一次 UI
// 使用 pending ref 暂存被节流的最新值，定时器补发最后一帧
const progressThrottle = new Map<string, number>();
const pendingUpdates = new Map<string, Partial<TransferItem>>();
const THROTTLE_MS = 200;

// 尾帧刷新定时器：每 200ms 检查是否有被节流的更新需要补发
let flushTimer: ReturnType<typeof setInterval> | null = null;

function ensureFlushTimer(set: (fn: (s: TransferState) => TransferState) => void) {
    if (flushTimer) return;
    flushTimer = setInterval(() => {
        if (pendingUpdates.size === 0) return;
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

export const useTransferStore = create<TransferState>((set) => ({
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
}));
