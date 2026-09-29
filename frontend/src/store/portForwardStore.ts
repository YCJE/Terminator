// 端口转发列表状态管理。
// 转发条目必须存活于组件之外：PortForwardingPage 会随视图切换被卸载，
// 若列表只存在组件本地 state，切走再回来列表会归零，而后端转发仍在运行，
// 导致 UI 与后端不一致且无法再删除（监听器泄漏）。
import { create } from "zustand";
import { PortForwardSpec } from "../../bindings/terminator-desktop/backend/internal/services/ssh/models";

/** 前端跟踪的端口转发条目，附带展示用的会话标题与运行状态 */
export interface TrackedForward extends PortForwardSpec {
    sessionTitle: string;
    status: "active" | "stopped";
}

interface PortForwardState {
    forwards: TrackedForward[];
    addForward: (forward: TrackedForward) => void;
    removeForward: (id: string) => void;
    restoreForward: (forward: TrackedForward) => void;
    /** 会话断开时把其名下所有转发标记为已停止 */
    markStoppedBySession: (sessionId: string) => void;
    /** 移除指定会话的全部转发条目 */
    removeBySession: (sessionId: string) => void;
    clearAll: () => void;
}

export const usePortForwardStore = create<PortForwardState>((set) => ({
    forwards: [],

    addForward: (forward) =>
        set((state) => ({forwards: [...state.forwards, forward]})),

    removeForward: (id) =>
        set((state) => ({forwards: state.forwards.filter((f) => f.id !== id)})),

    restoreForward: (forward) =>
        set((state) => ({forwards: [...state.forwards, forward]})),

    markStoppedBySession: (sessionId) =>
        set((state) => ({
            forwards: state.forwards.map((f) =>
                f.sessionId === sessionId ? {...f, status: "stopped" as const} : f
            ),
        })),

    removeBySession: (sessionId) =>
        set((state) => ({
            forwards: state.forwards.filter((f) => f.sessionId !== sessionId),
        })),

    clearAll: () => set({forwards: []}),
}));