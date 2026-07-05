import { create } from "zustand";
import { SSHConnectionConfig, SshService } from "../../bindings/terminator-desktop/backend/internal/services/ssh";
import { useUIStore, ViewType } from "@/store/uiStore";

export interface TerminalSession {
    id: string;
    title: string;
    config: SSHConnectionConfig;
}

export interface CreateSessionParams {
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    title?: string;
}

interface SessionState {
    sessions: TerminalSession[];
    activeSessionId: string | null;
    addSession: (params: CreateSessionParams) => void;
    removeSession: (id: string) => void;
    setActiveSession: (id: string) => void;
    clearSessions: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
    sessions: [],
    activeSessionId: null,

    addSession: (params) => {
        const state = get();

        // 检查是否已有相同主机+端口+用户名的会话
        // 如果有，直接切换到该会话，不另开标签
        const existing = state.sessions.find(
            (s) =>
                s.config.host === params.host &&
                s.config.port === params.port &&
                s.config.username === params.username
        );

        if (existing) {
            // 切换到已有会话
            useUIStore.getState().setActiveView(ViewType.Terminal);
            set({ activeSessionId: existing.id });
            return;
        }

        // 创建新会话
        const newId = crypto.randomUUID();

        const fullConfig = new SSHConnectionConfig({
            id: newId,
            host: params.host,
            port: params.port,
            username: params.username,
            password: params.password,
            privateKey: params.privateKey,
        });

        const newSession: TerminalSession = {
            id: newId,
            title: params.title || params.host,
            config: fullConfig,
        };

        useUIStore.getState().setActiveView(ViewType.Terminal);

        set({
            sessions: [...state.sessions, newSession],
            activeSessionId: newId,
        });
    },

    removeSession: (id) => {
        // 显式断开后端连接，不依赖组件卸载副作用
        SshService.Disconnect(id).catch(console.error);

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
                    useUIStore.getState().setActiveView(ViewType.Hosts);
                }
            }

            return {
                sessions: newSessions,
                activeSessionId: newActiveId,
            };
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

        // Wipe the local state and return to hosts
        useUIStore.getState().setActiveView(ViewType.Hosts);
        set({sessions: [], activeSessionId: null});
    }
}));
