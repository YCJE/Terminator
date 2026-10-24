import { create } from "zustand";
import { SSHConnectionConfig, SshService } from "../../bindings/terminator-desktop/backend/internal/services/ssh";
import { JumpHostConfig } from "../../bindings/terminator-desktop/backend/internal/services/ssh/models";
import { LocalShellService } from "../../bindings/terminator-desktop/backend/internal/services/local";
import { useUIStore, ViewType } from "@/store/uiStore";
import { useTransferStore } from "@/store/transferStore";
import { usePortForwardStore } from "@/store/portForwardStore";

export type SessionStatus = "connecting" | "connected" | "disconnected";

/** 会话来源：SSH 主机或本机 shell */
export type SessionKind = "ssh" | "local";

/** 分屏方向：row = 左右并排；column = 上下堆叠 */
export type SplitOrientation = "row" | "column";

/** 当前分屏状态：一对会话 ID 与方向。分屏不占用额外的标签页 */
export interface SplitState {
    primaryId: string;
    secondaryId: string;
    orientation: SplitOrientation;
}

export interface TerminalSession {
    id: string;
    title: string;
    config: SSHConnectionConfig;
    /** 会话来源：默认 ssh；local 表示本机 shell 终端 */
    kind?: SessionKind;
    /** 来源主机 ID（用于工作区恢复；分屏副窗格沿用它） */
    hostId?: string;
    disconnected?: boolean;
    status: SessionStatus;
    /** 标签页自定义颜色（十六进制色值，如 '#ef4444'），未设置时为 undefined */
    color?: string;
    /** 分屏产生的副窗格：不出现在标签栏，随分屏创建与销毁 */
    isSplitPane?: boolean;
    /** 连接成功后自动执行并回车发送的命令（来自主机配置） */
    onConnect?: string;
    /** 终端最近一次上报的当前目录（OSC 7），用于 SFTP 跟随 */
    cwd?: string;
    /** 重连计数：递增以触发终端组件重新建立连接 */
    reconnectNonce?: number;
    /** 非激活标签期间产生了新输出（标签栏显示活动点） */
    hasActivity?: boolean;
    /** 收到命令结束标记（OSC 133;D），标签栏显示完成提示 */
    commandDone?: boolean;
}

export interface CreateSessionParams {
    host: string;
    port: number;
    username: string;
    /** 来源主机 ID（可选），用于工作区恢复 */
    hostId?: string;
    password?: string;
    privateKey?: string;
    title?: string;
    /** 跳板机配置（可选），通过中间主机跳转连接目标 */
    jumpHost?: JumpHostConfig;
    proxyType?: string;
    proxyHost?: string;
    proxyPort?: number;
    proxyUsername?: string;
    proxyPassword?: string;
    agentForwarding?: boolean;
    /** 连接成功后自动执行的命令（可选） */
    onConnect?: string;
}

// 判断已有会话与新建参数是否使用完全相同的连接路由（跳板机链 + 代理）与凭据。
// 仅比较 host/port/username 会把"经不同跳板机/代理到达同一目标"或"同一目标但
// 使用不同密码/私钥/Agent 转发设置"的连接误判为重复会话，导致第二次连接静默
// 复用错误链路或错误凭据，用户以为连上了新会话实际用的是旧会话的认证信息。
function sameRoute(config: SSHConnectionConfig, params: CreateSessionParams): boolean {
    let a = config.jumpHost ?? null;
    let b = params.jumpHost ?? null;
    while (a && b) {
        if (a.host !== b.host || a.port !== b.port || a.username !== b.username) return false;
        a = a.jumpHost ?? null;
        b = b.jumpHost ?? null;
    }
    if (a || b) return false;
    const str = (v?: string) => v ?? "";
    const port = (v?: number) => v ?? 0;
    return (
        str(config.proxyType) === str(params.proxyType) &&
        str(config.proxyHost) === str(params.proxyHost) &&
        port(config.proxyPort) === port(params.proxyPort) &&
        str(config.proxyUsername) === str(params.proxyUsername) &&
        str(config.proxyPassword) === str(params.proxyPassword) &&
        str(config.password) === str(params.password) &&
        str(config.privateKey) === str(params.privateKey) &&
        (config.agentForwarding ?? false) === (params.agentForwarding ?? false)
    );
}

/** 按会话来源关闭底层传输：本地 shell 走 LocalShellService，其余走 SSH。 */
function closeSessionTransport(session: TerminalSession | undefined): void {
    if (!session) return;
    const promise = session.kind === "local"
        ? LocalShellService.Close(session.id)
        : SshService.Disconnect(session.id);
    promise.catch(console.error);
}

interface SessionState {
    sessions: TerminalSession[];
    activeSessionId: string | null;
    /** 广播模式：开启后在一个终端输入会同时发送到所有活跃终端 */
    broadcastMode: boolean;
    /** 当前分屏（一次只允许一组），为 null 时表示未分屏 */
    split: SplitState | null;
    addSession: (params: CreateSessionParams) => void;
    /** 新建本地 shell 终端标签 */
    addLocalSession: (title?: string) => void;
    removeSession: (id: string) => void;
    setActiveSession: (id: string) => void;
    /** 非激活标签产生的输出：点亮活动指示点 */
    markSessionActivity: (id: string) => void;
    /** 收到命令结束标记：点亮完成指示点 */
    markSessionDone: (id: string) => void;
    markSessionDisconnected: (id: string) => void;
    setSessionStatus: (id: string, status: SessionStatus) => void;
    setSessionColor: (id: string, color: string) => void;
    /** 记录终端上报的当前目录（OSC 7） */
    setSessionCwd: (id: string, cwd: string) => void;
    /** 重连会话：复位断开状态并触发终端组件重新连接 */
    reconnectSession: (id: string) => void;
    /** 按会话 ID 重排标签（拆分屏后标签栏过滤了副窗格，索引不再与完整数组对应） */
    reorderSessionsByIds: (fromId: string, toId: string) => void;
    clearSessions: () => void;
    toggleBroadcastMode: () => void;
    /** 直接设置广播模式开关 */
    setBroadcastMode: (enabled: boolean) => void;
    /** 获取所有活跃（已连接）的会话 ID */
    getActiveSessionIds: () => string[];
    /** 将当前会话一分为二（新建一个同配置会话作为副窗格） */
    splitActiveSession: (orientation: SplitOrientation) => void;
    /** 关闭分屏，保留主窗格 */
    closeSplit: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
    sessions: [],
    activeSessionId: null,
    broadcastMode: false,
    split: null,

    addSession: (params) => {
        const state = get();

        // 检查是否已有相同主机+端口+用户名且连接路由一致的活跃会话
        const existing = state.sessions.find(
            (s) =>
                s.config.host === params.host &&
                s.config.port === params.port &&
                s.config.username === params.username &&
                !s.disconnected &&
                sameRoute(s.config, params)
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
            jumpHost: params.jumpHost,
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
            hostId: params.hostId,
            status: "connecting",
            onConnect: params.onConnect?.trim() || undefined,
        };

        useUIStore.getState().setActiveView(ViewType.Terminal);

        set({
            sessions: [...state.sessions, newSession],
            activeSessionId: newId,
        });
    },

    addLocalSession: (title) => {
        const id = crypto.randomUUID();
        // 本地会话不涉及远端凭据，config 只用于复用终端组件的字段结构
        const config = new SSHConnectionConfig({
            id,
            host: "local",
            port: 0,
            username: "",
        });
        const session: TerminalSession = {
            id,
            title: title || "本地终端",
            config,
            kind: "local",
            status: "connecting",
        };
        useUIStore.getState().setActiveView(ViewType.Terminal);
        set((state) => ({
            sessions: [...state.sessions, session],
            activeSessionId: id,
        }));
    },

    removeSession: (id) => {
        closeSessionTransport(get().sessions.find((s) => s.id === id));
        // 清理关联的传输任务，避免孤儿数据
        useTransferStore.getState().removeTransfersBySession(id);
        // 一并清理该会话的端口转发条目：后端 Disconnect 已关闭其监听器，
        // 若只把条目留在 store，端口转发页会长期残留"已停止"的孤儿行、计数虚高
        usePortForwardStore.getState().removeBySession(id);

        const state = get();
        const split = state.split;
        const inSplit = !!split && (split.primaryId === id || split.secondaryId === id);

        let sessions = state.sessions;
        let activeSessionId = state.activeSessionId;
        let nextSplit = state.split;

        if (split && inSplit) {
            nextSplit = null;
            if (split.primaryId === id) {
                // 关闭主窗格：副窗格提升为普通标签，连接不中断
                sessions = sessions.map((s) =>
                    s.id === split.secondaryId ? {...s, isSplitPane: false} : s
                );
                if (activeSessionId === id) activeSessionId = split.secondaryId;
            } else if (activeSessionId === id) {
                activeSessionId = split.primaryId;
            }
        }

        const newSessions = sessions.filter((s) => s.id !== id);
        let shouldGoToHosts = false;

        if (activeSessionId === id) {
            // 回退到前一个普通标签；分屏副窗格不参与标签切换
            const normalSessions = newSessions.filter((s) => !s.isSplitPane);
            if (normalSessions.length > 0) {
                const closedIndex = state.sessions.findIndex((s) => s.id === id);
                activeSessionId = (normalSessions.filter(
                    (s) => state.sessions.findIndex((x) => x.id === s.id) < closedIndex
                ).pop() || normalSessions[0]).id;
            } else {
                activeSessionId = null;
                shouldGoToHosts = true;
            }
        }

        set({
            sessions: newSessions,
            activeSessionId,
            split: nextSplit,
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
        // 会话断开时后端已关闭其全部端口转发监听器，同步标记前端列表
        usePortForwardStore.getState().markStoppedBySession(id);
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

    setSessionCwd: (id, cwd) => {
        set((state) => ({
            sessions: state.sessions.map((s) =>
                s.id === id && s.cwd !== cwd ? { ...s, cwd } : s
            ),
        }));
    },

    reconnectSession: (id) => {
        set((state) => ({
            sessions: state.sessions.map((s) =>
                s.id === id
                    ? {
                        ...s,
                        status: "connecting" as const,
                        disconnected: false,
                        reconnectNonce: (s.reconnectNonce ?? 0) + 1,
                    }
                    : s
            ),
        }));
    },

    reorderSessionsByIds: (fromId, toId) => {
        set((state) => {
            // 拖拽使用会话 ID 而非数组下标：分屏副窗格不出现在标签栏，
            // 标签下标与 sessions 数组下标不一致，按下标替换会移动错误的标签。
            const fromIndex = state.sessions.findIndex((s) => s.id === fromId);
            const toIndex = state.sessions.findIndex((s) => s.id === toId);
            if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
                return {};
            }
            const sessions = [...state.sessions];
            const [moved] = sessions.splice(fromIndex, 1);
            sessions.splice(toIndex, 0, moved);
            return { sessions };
        });
    },

    markSessionActivity: (id) => {
        // 正在查看的标签无需活动提示（避免每块输出都触发一次状态比较）
        if (get().activeSessionId === id) return;
        set((state) => {
            const target = state.sessions.find((s) => s.id === id);
            if (!target || target.hasActivity) return {};
            return {
                sessions: state.sessions.map((s) => (s.id === id ? {...s, hasActivity: true} : s)),
            };
        });
    },

    markSessionDone: (id) => {
        set((state) => {
            const target = state.sessions.find((s) => s.id === id);
            if (!target || target.commandDone) return {};
            return {
                sessions: state.sessions.map((s) => (s.id === id ? {...s, commandDone: true} : s)),
            };
        });
    },

    setActiveSession: (id) => {
        useUIStore.getState().setActiveView(ViewType.Terminal);
        set((state) => {
            const needsClear = state.sessions.some(
                (s) => s.id === id && (s.hasActivity || s.commandDone)
            );
            if (!needsClear) return {activeSessionId: id};
            return {
                activeSessionId: id,
                sessions: state.sessions.map((s) =>
                    s.id === id ? {...s, hasActivity: false, commandDone: false} : s
                ),
            };
        });
    },

    clearSessions: () => {
        const {sessions} = get();
        sessions.forEach((session) => {
            closeSessionTransport(session);
        });

        // 清空所有传输任务
        useTransferStore.getState().clearAll();
        // 所有会话均已断开，端口转发条目一并清空
        usePortForwardStore.getState().clearAll();
        useUIStore.getState().setActiveView(ViewType.Hosts);
        useUIStore.getState().setFilePanelVisible(false);
        set({sessions: [], activeSessionId: null, split: null});
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
    },

    splitActiveSession: (orientation) => {
        const state = get();
        // 一次只支持一组分屏：已有分屏时先由用户取消，避免嵌套分屏带来的布局歧义
        if (state.split) return;

        const active = state.sessions.find((s) => s.id === state.activeSessionId);
        if (!active || active.isSplitPane || active.disconnected) return;

        const newId = crypto.randomUUID();
        // 复用主窗格的完整连接参数（含跳板链、代理与凭据），仅替换会话 ID
        const config = new SSHConnectionConfig({...active.config, id: newId});
        const secondary: TerminalSession = {
            id: newId,
            title: active.title,
            config,
            kind: active.kind,
            hostId: active.hostId,
            status: "connecting",
            isSplitPane: true,
            onConnect: active.onConnect,
        };

        set({
            sessions: [...state.sessions, secondary],
            split: {
                primaryId: active.id,
                secondaryId: newId,
                orientation,
            },
            activeSessionId: newId,
        });
        // 从设置页等非终端视图触发时，切回终端以展示新窗格
        useUIStore.getState().setActiveView(ViewType.Terminal);
    },

    closeSplit: () => {
        const state = get();
        const split = state.split;
        if (!split) return;

        closeSessionTransport(state.sessions.find((s) => s.id === split.secondaryId));
        useTransferStore.getState().removeTransfersBySession(split.secondaryId);
        usePortForwardStore.getState().removeBySession(split.secondaryId);

        set({
            sessions: state.sessions.filter((s) => s.id !== split.secondaryId),
            split: null,
            activeSessionId: state.activeSessionId === split.secondaryId
                ? split.primaryId
                : state.activeSessionId,
        });
    }
}));
