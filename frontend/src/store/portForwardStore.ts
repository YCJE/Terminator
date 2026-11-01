// 端口转发列表状态管理。
// 转发条目必须存活于组件之外：PortForwardingPage 会随视图切换被卸载，
// 若列表只存在组件本地 state，切走再回来列表会归零，而后端转发仍在运行，
// 导致 UI 与后端不一致且无法再删除（监听器泄漏）。
//
// 持久化：每次新建/删除都同步到 localStorage（按主机作用域记录），
// 应用重启后列表先以"已停止"展示，会话连上后由 PortForwardRestorer 自动重建。
import { create } from "zustand";
import { PortForwardSpec } from "../../bindings/terminator-desktop/backend/internal/services/ssh/models";
import {
    loadStoredForwards,
    removeStoredForward,
    upsertStoredForward,
    type StoredForward,
} from "@/lib/portForwardPersistence";

/** 前端跟踪的端口转发条目，附带展示用的会话标题与运行状态 */
export interface TrackedForward extends PortForwardSpec {
    sessionTitle: string;
    status: "active" | "stopped";
    /** 持久化记录的稳定 ID：运行时 id 每次恢复都会重新生成，靠它做去重与删除 */
    persistedId: string;
    /** 主机作用域：恢复时按它匹配会话 */
    scope: string;
}

/** 新建转发的入参：运行时字段齐全，另外带上持久化所需的 scope */
export type NewForward = Omit<TrackedForward, "persistedId"> & { persistedId?: string };

interface PortForwardState {
    forwards: TrackedForward[];
    /** 新建转发：写入列表并持久化 */
    addForward: (forward: NewForward) => TrackedForward;
    /** 删除转发：同时删除持久化记录 */
    removeForward: (id: string) => void;
    /** 恢复失败时把条目放回列表（删除操作后端的调用失败时回滚） */
    restoreForward: (forward: TrackedForward) => void;
    /** 自动恢复成功：把持久化记录绑定到具体会话并标记为运行中 */
    activateRestored: (
        persistedId: string,
        sessionId: string,
        sessionTitle: string,
        scope: string,
        runtime: PortForwardSpec,
    ) => void;
    /** 会话断开时把其名下所有转发标记为已停止 */
    markStoppedBySession: (sessionId: string) => void;
    /** 从持久化配置重新补齐列表占位条目（页面打开时调用） */
    reloadStored: () => void;
    clearAll: () => void;
}

/** 把持久化记录转成列表条目（尚未建立连接，状态为已停止） */
function fromStored(record: StoredForward): TrackedForward {
    return {
        id: `stored-${record.id}`,
        sessionId: "",
        type: record.type,
        localHost: record.localHost,
        localPort: record.localPort,
        remoteHost: record.remoteHost,
        remotePort: record.remotePort,
        sessionTitle: record.sessionTitle,
        status: "stopped",
        persistedId: record.id,
        scope: record.scope,
    };
}

/** 列表条目转持久化记录 */
function toStored(forward: TrackedForward): StoredForward {
    return {
        id: forward.persistedId,
        scope: forward.scope,
        sessionTitle: forward.sessionTitle,
        type: forward.type === "remote" ? "remote" : "local",
        localHost: forward.localHost,
        localPort: forward.localPort,
        remoteHost: forward.remoteHost,
        remotePort: forward.remotePort,
    };
}

export const usePortForwardStore = create<PortForwardState>((set, get) => ({
    // 启动时先按持久化配置展示：连上主机后由 PortForwardRestorer 接管状态
    forwards: loadStoredForwards().map(fromStored),

    addForward: (forward) => {
        const record = upsertStoredForward(toStored({
            ...forward,
            persistedId: forward.persistedId ?? forward.id,
            scope: forward.scope,
        }));
        const tracked: TrackedForward = {
            ...forward,
            persistedId: record.id,
            sessionTitle: forward.sessionTitle,
            status: "active",
        };
        set((state) => {
            // 同一条持久化记录可能已有"已停止"占位条目：用运行时条目替换它
            const rest = state.forwards.filter((item) => item.persistedId !== record.id);
            return {forwards: [...rest, tracked]};
        });
        return tracked;
    },

    removeForward: (id) => {
        const target = get().forwards.find((item) => item.id === id);
        if (target?.persistedId) removeStoredForward(target.persistedId);
        set((state) => ({forwards: state.forwards.filter((f) => f.id !== id)}));
    },

    restoreForward: (forward) =>
        set((state) => ({forwards: [...state.forwards, forward]})),

    activateRestored: (persistedId, sessionId, sessionTitle, scope, runtime) => {
        set((state) => {
            // 已经存在同一条运行时条目（并发恢复/重复触发）时不重复添加
            if (state.forwards.some((item) => item.id === runtime.id)) return state;
            const rest = state.forwards.filter((item) => item.persistedId !== persistedId);
            return {
                forwards: [...rest, {
                    ...runtime,
                    sessionTitle,
                    status: "active" as const,
                    persistedId,
                    scope,
                }],
            };
        });
    },

    markStoppedBySession: (sessionId) =>
        set((state) => ({
            forwards: state.forwards.map((f) =>
                f.sessionId === sessionId
                    ? {...f, status: "stopped" as const, sessionId: ""}
                    : f
            ),
        })),

    reloadStored: () => {
        set((state) => {
            const known = new Set(state.forwards.map((item) => item.persistedId));
            const placeholders = loadStoredForwards()
                .filter((record) => !known.has(record.id))
                .map(fromStored);
            return placeholders.length === 0
                ? state
                : {forwards: [...state.forwards, ...placeholders]};
        });
    },

    clearAll: () => {
        // 只清内存列表：锁屏/擦除时转发配置本身不含敏感信息，
        // 保留持久化记录，下次连上主机仍能恢复；用户可在页面上显式删除
        set({forwards: []});
    },
}));
