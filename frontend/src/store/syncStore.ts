import { create } from "zustand";
import { Events } from "@wailsio/runtime";
import { SyncStatus } from "../../bindings/terminator-desktop/backend/internal/services/sync";
import { AppEvent } from "@/lib/events.ts";
import { AppClientError, parseAppError } from "@/lib/error.ts";

interface SyncState {
    status: SyncStatus;
    lastError: AppClientError | null;
    setStatus: (status: SyncStatus) => void;
}

// 模块级订阅句柄，确保 HMR 或重复加载时能先取消旧订阅再注册新订阅，
// 避免事件多次绑定导致内存泄漏和重复 setState。
let unsubStatus: (() => void) | null = null;
let unsubError: (() => void) | null = null;

export const useSyncStore = create<SyncState>((set) => {
    // 先清理旧订阅（HMR 场景）
    if (unsubStatus) { try { unsubStatus(); } catch { /* ignore */ } }
    if (unsubError) { try { unsubError(); } catch { /* ignore */ } }

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

    return {
        status: SyncStatus.SyncStatusIdle,
        lastError: null,
        setStatus: (status) => set({ status }),
    };
});
