import { create } from "zustand";
import { Events } from "@wailsio/runtime";
import { SyncService, SyncStatus } from "../../bindings/terminator-desktop/backend/internal/services/sync";
import { AppEvent } from "@/lib/events.ts";
import { AppClientError, parseAppError } from "@/lib/error.ts";

interface SyncState {
    status: SyncStatus;
    lastError: AppClientError | null;
    /** 未解决的同步冲突数量，用于侧边栏徽标与全局横幅提示 */
    conflictCount: number;
    setStatus: (status: SyncStatus) => void;
    setConflictCount: (count: number) => void;
    /** 重新拉取冲突数量；失败时保留原值，避免提示闪烁 */
    refreshConflicts: () => Promise<void>;
}

// 模块级订阅句柄，确保 HMR 或重复加载时能先取消旧订阅再注册新订阅，
// 避免事件多次绑定导致内存泄漏和重复 setState。
let unsubStatus: (() => void) | null = null;
let unsubError: (() => void) | null = null;
let unsubUpdates: (() => void) | null = null;

export const useSyncStore = create<SyncState>((set, get) => {
    // 先清理旧订阅（HMR 场景）
    if (unsubStatus) { try { unsubStatus(); } catch { /* ignore */ } }
    if (unsubError) { try { unsubError(); } catch { /* ignore */ } }
    if (unsubUpdates) { try { unsubUpdates(); } catch { /* ignore */ } }

    unsubStatus = Events.On(AppEvent.SyncStatus, (event) => {
        const status = event?.data as SyncStatus;
        if (!status) return;
        set((state) => ({
            status,
            lastError: (status === SyncStatus.SyncStatusSuccess)
                ? null
                : state.lastError
        }));
    });

    unsubError = Events.On(AppEvent.SyncError, (event) => {
        const parsedError = parseAppError(event?.data);
        set({
            status: SyncStatus.SyncStatusError,
            lastError: parsedError
        });
    });

    // 每轮同步检测到冲突或应用了远端改动后都会发出该事件，
    // 借此刷新冲突计数，无需额外轮询。
    unsubUpdates = Events.On(AppEvent.SyncUpdatesAvailable, () => {
        void get().refreshConflicts();
    });

    return {
        status: SyncStatus.SyncStatusIdle,
        lastError: null,
        conflictCount: 0,
        setStatus: (status) => set({ status }),
        setConflictCount: (conflictCount) => set({ conflictCount }),
        refreshConflicts: async () => {
            try {
                set({ conflictCount: await SyncService.ConflictCount() });
            } catch (error) {
                // 冲突计数只是提示信息，读取失败不应打断同步或弹错
                console.debug("refresh conflict count failed", error);
            }
        },
    };
});
