import { create } from "zustand";
import { SSHConnectionConfig, SshService } from "../../bindings/terminator-desktop/backend/internal/services/ssh";
import { useUIStore, ViewType } from "@/store/uiStore";

export type SessionStatus = "connecting" | "connected" | "disconnected";

export interface TerminalSession {
    id: string;
    title: string;
    config: SSHConnectionConfig;
    disconnected?: boolean;
    status: SessionStatus;
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
    markSessionDisconnected: (id: string) => void;
    setSessionStatus: (id: string, status: SessionStatus) => void;
    reorderSessions: (fromIndex: number, toIndex: number) => void;
    clearSessions: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
    sessions: [],
    activeSessionId: null,

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

        useUIStore.getState().setActiveView(ViewType.Hosts);
        set({sessions: [], activeSessionId: null});
    }
}));
