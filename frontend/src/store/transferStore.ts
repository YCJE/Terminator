// 文件传输队列状态管理

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

export const useTransferStore = create<TransferState>((set) => ({
    transfers: [],

    addTransfer: (item) => set((state) => ({
        transfers: [...state.transfers, item],
    })),

    updateTransfer: (id, updates) => set((state) => ({
        transfers: state.transfers.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),

    removeTransfer: (id) => set((state) => ({
        transfers: state.transfers.filter((t) => t.id !== id),
    })),

    clearCompleted: () => set((state) => ({
        transfers: state.transfers.filter((t) => t.status === "active"),
    })),
}));
