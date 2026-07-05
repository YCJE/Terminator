// 文件传输队列状态管理
// 优化：进度更新节流，避免高频事件导致 React 狂暴重渲染

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
    /** 新增一个传输任务 */
    addTransfer: (item: TransferItem) => void;
    /** 更新某个传输任务的状态 */
    updateTransfer: (id: string, updates: Partial<TransferItem>) => void;
    /** 移除某个传输任务 */
    removeTransfer: (id: string) => void;
    /** 清除所有已完成的传输任务 */
    clearCompleted: () => void;
}

// 进度节流：同一 transferID 的进度事件最多每 200ms 更新一次 UI
// 后端每 32KB 发一次进度，大文件传输时每秒可达数百次事件
// 用 Map 记录上次更新时间，跳过过快的更新
const progressThrottle = new Map<string, number>();
const THROTTLE_MS = 200;

export const useTransferStore = create<TransferState>((set, get) => ({
    transfers: [],

    addTransfer: (item) => {
        // 新增时重置节流计时
        progressThrottle.delete(item.id);
        set((state) => ({
            transfers: [...state.transfers, item],
        }));
    },

    updateTransfer: (id, updates) => {
        // 完成或错误事件立即处理，不节流
        if (updates.status === "success" || updates.status === "error") {
            progressThrottle.delete(id);
            set((state) => ({
                transfers: state.transfers.map((t) => (t.id === id ? { ...t, ...updates } : t)),
            }));
            return;
        }

        // 进度更新节流：检查距上次更新是否已过 THROTTLE_MS
        const now = Date.now();
        const lastTime = progressThrottle.get(id) ?? 0;
        if (now - lastTime < THROTTLE_MS) {
            // 跳过本次更新，但记录最新值到 ref（下次定时刷新时会用到）
            return;
        }
        progressThrottle.set(id, now);

        set((state) => ({
            transfers: state.transfers.map((t) => (t.id === id ? { ...t, ...updates } : t)),
        }));
    },

    removeTransfer: (id) => {
        progressThrottle.delete(id);
        set((state) => ({
            transfers: state.transfers.filter((t) => t.id !== id),
        }));
    },

    clearCompleted: () => set((state) => ({
        transfers: state.transfers.filter((t) => t.status === "active"),
    })),
}));
