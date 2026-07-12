import { create } from "zustand";
import { SSHConnectionConfig, SshService } from "../../bindings/terminator-desktop/backend/internal/services/ssh";
import { useUIStore, ViewType } from "@/store/uiStore";
import { useTransferStore } from "@/store/transferStore";

export type SessionStatus = "connecting" | "connected" | "disconnected";

export interface TerminalSession {
    id: string;
    title: string;
    config: SSHConnectionConfig;
    disconnected?: boolean;
    status: SessionStatus;
    /** 标签页自定义颜色（十六进制色值，如 '#ef4444'），未设置时为 undefined */
    color?: string;
}

export interface CreateSessionParams {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    title?: string;
    proxyType?: string;
    proxyHost?: string;
    proxyPort?: number;
    proxyUsername?: string;
    proxyPassword?: string;
    agentForwarding?: boolean;
}

interface SessionState {
    sessions: TerminalSession[];
    activeSessionId: string | null;
    /** 广播模式：开启后在一个终端输入会同时发送到所有活跃终端 */
    broadcastMode: boolean;
    addSession: (params: CreateSessionParams) => void;
    removeSession: (id: string) => void;
    setActiveSession: (id: string) => void;
    markSessionDisconnected: (id: string) => void;
    setSessionStatus: (id: string, status: SessionStatus) => void;
    setSessionColor: (id: string, color: string) => void;
    reorderSessions: (fromIndex: number, toIndex: number) => void;
    clearSessions: () => void;
    toggleBroadcastMode: () => void;
    /** 直接设置广播模式开关 */
    setBroadcastMode: (enabled: boolean) => void;
    /** 获取所有活跃（已连接）的会话 ID */
    getActiveSessionIds: () => string[];
}

export const useSessionStore = create<SessionState>((set, get) => ({
    sessions: [],
    activeSessionId: null,
    broadcastMode: false,

    addSession: (params) => {
        const state = get();

        // 检查是否已有相同主机+端口+用户名的活跃会话
        const existing = state.sessions.find(
            (s) =>
                s.config.host === params.host &&
                s.config.port === params.port &&
                s.config.username === params.username &&
                !s.disconnected
        );

        if (existing) {
            useUIStore.getState().setActiveView(ViewType.Terminal);
            set({ activeSessionId: existing.id });
            return;
        }

        const newId = crypto.randomUUID();

        const fullConfig = new SSHConnectionConfig({
            id: newId,
            host: params.host,
            port: params.port,
            username: params.username,
            password: params.password,
            privateKey: params.privateKey,
            proxyType: params.proxyType,
            proxyHost: params.proxyHost,
            proxyPort: params.proxyPort,
            proxyUsername: params.proxyUsername,
            proxyPassword: params.proxyPassword,
            agentForwarding: params.agentForwarding,
        });

        const newSession: TerminalSession = {
            id: newId,
            title: params.title || params.host,
            config: fullConfig,
            status: "connecting",
        };

        useUIStore.getState().setActiveView(ViewType.Terminal);

        set({
            sessions: [...state.sessions, newSession],
            activeSessionId: newId,
        });
    },

    removeSession: (id) => {
        SshService.Disconnect(id).catch(console.error);
        // 清理关联的传输任务，避免孤儿数据
        useTransferStore.getState().removeTransfersBySession(id);

        let shouldGoToHosts = false;

        set((state) => {
            const newSessions = state.sessions.filter((s) => s.id !== id);
            let newActiveId = state.activeSessionId;

            if (state.activeSessionId === id) {
                if (newSessions.length > 0) {
                    const closedIndex = state.sessions.findIndex((s) => s.id === id);
                    const fallbackSession = newSessions[closedIndex - 1] || newSessions[0];
                    newActiveId = fallbackSession.id;
                } else {
                    newActiveId = null;
                    shouldGoToHosts = true;
                }
            }

            return {
                sessions: newSessions,
                activeSessionId: newActiveId,
            };
        });

        // 在 set 之外触发其他 store 的状态变更，避免更新顺序不确定
        if (shouldGoToHosts) {
            useUIStore.getState().setActiveView(ViewType.Hosts);
            useUIStore.getState().setFilePanelVisible(false);
        }
    },

    markSessionDisconnected: (id) => {
        set((state) => ({
            sessions: state.sessions.map((s) =>
                s.id === id ? { ...s, disconnected: true, status: "disconnected" as const } : s
            ),
        }));
    },

    setSessionStatus: (id, status) => {
        set((state) => ({
            sessions: state.sessions.map((s) =>
                s.id === id ? { ...s, status, disconnected: status === "disconnected" } : s
            ),
        }));
    },

    setSessionColor: (id, color) => {
        set((state) => ({
            sessions: state.sessions.map((s) =>
                // 传空字符串时清除颜色（设为 undefined）
                s.id === id ? { ...s, color: color || undefined } : s
            ),
        }));
    },

    reorderSessions: (fromIndex, toIndex) => {
        set((state) => {
            const sessions = [...state.sessions];
            const [moved] = sessions.splice(fromIndex, 1);
            sessions.splice(toIndex, 0, moved);
            return { sessions };
        });
    },

    setActiveSession: (id) => {
        useUIStore.getState().setActiveView(ViewType.Terminal);
        set({activeSessionId: id});
    },

    clearSessions: () => {
        const {sessions} = get();
        sessions.forEach((session) => {
            SshService.Disconnect(session.id).catch(console.error);
        });

        // 清空所有传输任务
        useTransferStore.getState().clearAll();
        useUIStore.getState().setActiveView(ViewType.Hosts);
        useUIStore.getState().setFilePanelVisible(false);
        set({sessions: [], activeSessionId: null});
    },

    toggleBroadcastMode: () => {
        set((state) => ({broadcastMode: !state.broadcastMode}));
    },

    setBroadcastMode: (enabled: boolean) => {
        set({broadcastMode: enabled});
    },

    getActiveSessionIds: () => {
        return get().sessions
            .filter((s) => s.status === "connected" && !s.disconnected)
            .map((s) => s.id);
    }
}));
